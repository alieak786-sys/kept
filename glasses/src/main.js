import { checkServerHealth } from './api.js'
import {
  AudioInputSource,
  waitForEvenAppBridge,
  TextContainerProperty,
  CreateStartUpPageContainer,
  TextContainerUpgrade,
  OsEventTypeList,
} from '@evenrealities/even_hub_sdk'

const SWIPE_UP = 1
const SWIPE_DOWN = 2
const LONG_PRESS = 10

const API_URL = 'http://localhost:3000/api/audio'
const APPROVE_URL = 'http://localhost:3000/api/cards/approve'
const DUPLICATE_WINDOW_MS = 60000 // same promise within 60 s is treated as a duplicate
// 16 kHz x 2 bytes x 10 seconds
const AUDIO_CHUNK_BYTES = 320000
const AUDIO_BYTES_PER_SECOND = 32000

const SCREENS = {
  paused: 'Paused\n\nSwipe up: resume\nHold: end meeting',
}

function capitalise(text) {
  return text.charAt(0).toUpperCase() + text.slice(1)
}

// "2026-11-27" -> "Fri 27 Nov"
function formatDue(due) {
  if (!due) return 'No date'
  const date = new Date(`${due}T12:00:00`)
  if (Number.isNaN(date.getTime())) return due
  return date.toLocaleDateString('en-GB', {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
  })
}

function cardText(card) {
  return `! Promise caught\n${capitalise(card.task).slice(0, 60)}\nDue: ${formatDue(card.due)}\n\nTap = add\nSwipe down = skip`
}

function cardKey(card) {
  return `${card.task}|${card.person}|${card.due}`.toLowerCase()
}

async function main() {
  const bridge = await waitForEvenAppBridge()

  let state = 'idle'
  let serverStatus = 'Checking...'

  // Microphone state
  let microphoneActive = false
  let microphoneStatus = 'OFF'
  let audioChunkCount = 0

  // Audio buffer and upload state
  let audioBuffer = new Uint8Array(AUDIO_CHUNK_BYTES)
  let audioBufferOffset = 0
  let uploadedChunkCount = 0
  let uploadStatus = 'Waiting'
  let lastHeard = ''
  let lastPromises = 0

  // Keep uploads in order
  let uploadQueue = Promise.resolve()

  // Promise cards
  let currentCard = null
  let pendingCards = []
  let saveMessage = ''
  const seenKeys = new Map() // promise key -> time it was shown
  function getScreenContent(screen) {
    if (screen === 'idle') {
      return `Kept\n\nServer: ${serverStatus}\nTap to start meeting\nDouble tap to exit`
    }

    if (screen === 'listening') {
      const bufferedSeconds = (
        audioBufferOffset / AUDIO_BYTES_PER_SECOND
      ).toFixed(1)

      return `* Listening | Mic: ${microphoneStatus}\nSent: ${uploadedChunkCount} | ${uploadStatus} | Buffer ${bufferedSeconds}s\nHeard: ${lastHeard || '-'}\nPromises: ${lastPromises}\nSwipe up: pause\nHold: end meeting`    }

    if (screen === 'card') {
      return currentCard ? cardText(currentCard) : 'No card'
    }
    if (screen === 'saved') {
      return saveMessage
    }
    return SCREENS[screen]
  }

  const mainText = new TextContainerProperty({
    xPosition: 0,
    yPosition: 0,
    width: 576,
    height: 288,
    borderWidth: 0,
    borderColor: 5,
    paddingLength: 4,
    containerID: 1,
    containerName: 'main',
    content: getScreenContent('idle'),
    isEventCapture: 1,
  })

  const result = await bridge.createStartUpPageContainer(
    new CreateStartUpPageContainer({
      containerTotalNum: 1,
      textObject: [mainText],
    }),
  )

  console.log('Page created:', result === 0 ? 'success' : `failed (${result})`)

  function show(newState) {
    state = newState

    bridge.textContainerUpgrade(
      new TextContainerUpgrade({
        containerID: 1,
        containerName: 'main',
        content: getScreenContent(newState),
      }),
    )
  }

  // ---- Promise cards ----

  function showNextCard() {
    currentCard = pendingCards.shift() || null
    show(currentCard ? 'card' : 'listening')
  }

  function enqueueCards(list) {
    // Cards only matter while a meeting is running
    if (state !== 'listening' && state !== 'card' && state !== 'saved') return

    for (const card of list) {
           const key = cardKey(card)
      const lastSeen = seenKeys.get(key)
      if (lastSeen && Date.now() - lastSeen < DUPLICATE_WINDOW_MS) continue
      seenKeys.set(key, Date.now())
      pendingCards.push(card)
    }

    if (state === 'listening' && pendingCards.length > 0) {
      showNextCard()
    }
  }

  function clearCards() {
    currentCard = null
    pendingCards = []
    seenKeys.clear()
  }

  // Later (Day 5) this will create the Notion task and Calendar event
    async function approveCard(card) {
    saveMessage = 'Saving...\nNotion'
    show('saved')

    try {
      const response = await fetch(APPROVE_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(card),
      })
      const data = await response.json()
      if (!response.ok || !data.ok) throw new Error(`HTTP ${response.status}`)
      saveMessage = 'Saved\nNotion'
    } catch (error) {
      console.error('Save failed:', error)
      saveMessage = 'Save failed\nCheck server'
    }

    if (state === 'saved') show('saved')
    setTimeout(() => {
      if (state === 'saved') showNextCard()
    }, 1500)
  }

  // ---- Audio ----

  // Discard incomplete audio when capture stops
  function resetAudioBuffer() {
    audioBuffer = new Uint8Array(AUDIO_CHUNK_BYTES)
    audioBufferOffset = 0
  }

  // Upload one complete 10-second audio chunk
  function uploadAudioChunk(chunk) {
    uploadQueue = uploadQueue.then(async () => {
      const response = await fetch(API_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/octet-stream',
        },
        body: chunk,
      })

      const data = await response.json()

      if (!response.ok || !data.ok) {
        throw new Error(`Audio upload failed: HTTP ${response.status}`)
      }

      uploadedChunkCount++
      uploadStatus = 'OK'
      lastHeard = (data.text || '').slice(0, 24)
      lastPromises = data.commitments?.length ?? 0

      console.log(
        'Uploaded audio chunk:',
        uploadedChunkCount,
        'Received bytes:',
        data.received,
        'Promises:',
        data.commitments?.length ?? 0,
      )

      if (Array.isArray(data.commitments) && data.commitments.length > 0) {
        enqueueCards(data.commitments)
      }

      // Refresh the counters if we are still on the listening screen
      if (state === 'listening') {
        show('listening')
      }
    }).catch((error) => {
      uploadStatus = 'FAILED'
      console.error('Audio upload error:', error)

      if (state === 'listening') {
        show('listening')
      }
    })
  }

  // Add incoming PCM data to the 10-second buffer
  function bufferAudio(pcm) {
    let sourceOffset = 0

    while (sourceOffset < pcm.length) {
      const availableSpace = AUDIO_CHUNK_BYTES - audioBufferOffset

      const bytesToCopy = Math.min(
        availableSpace,
        pcm.length - sourceOffset,
      )

      audioBuffer.set(
        pcm.subarray(sourceOffset, sourceOffset + bytesToCopy),
        audioBufferOffset,
      )

      audioBufferOffset += bytesToCopy
      sourceOffset += bytesToCopy

      // Buffer is full: upload the complete 10-second chunk
      if (audioBufferOffset === AUDIO_CHUNK_BYTES) {
        const completedChunk = audioBuffer

        // Create a fresh buffer for the next recording
        audioBuffer = new Uint8Array(AUDIO_CHUNK_BYTES)
        audioBufferOffset = 0

        uploadAudioChunk(completedChunk)
      }
    }
  }

  async function startMicrophone() {
    if (microphoneActive) return

    resetAudioBuffer()
    microphoneStatus = 'Starting'

    if (state === 'listening') show('listening')

    try {
      const started = await bridge.audioControl(
        true,
        AudioInputSource.Glasses,
      )

      microphoneActive = started === true
      microphoneStatus = microphoneActive ? 'ON' : 'FAILED'

      console.log('Microphone start result:', started)
    } catch (error) {
      microphoneActive = false
      microphoneStatus = 'FAILED'
      console.error('Microphone start failed:', error)
    }

    if (state === 'listening') show('listening')
  }

  async function stopMicrophone() {
    resetAudioBuffer()

    if (!microphoneActive) return

    try {
      const stopped = await bridge.audioControl(false)

      microphoneActive = false
      microphoneStatus = 'OFF'

      console.log('Microphone stop result:', stopped)
    } catch (error) {
      console.error('Microphone stop failed:', error)
      microphoneStatus = 'STOP FAILED'
    }
  }

  async function endMeeting() {
    await stopMicrophone()
    clearCards()
    show('idle')
  }

  function eventTypeOf(envelope) {
    if (!envelope) return null
    return envelope.eventType ?? OsEventTypeList.CLICK_EVENT
  }

  bridge.onEvenHubEvent(async (event) => {
    // Receive microphone PCM events
    const audio = event.audioEvent

    if (microphoneActive && audio?.audioPcm?.length) {
      audioChunkCount++

      bufferAudio(audio.audioPcm)

      // Update display every 10 audio events
      if (audioChunkCount % 10 === 0) {
        console.log(
          'Audio events received:',
          audioChunkCount,
          'Buffered bytes:',
          audioBufferOffset,
        )

        if (state === 'listening') {
          show('listening')
        }
      }
    }

    const sys = eventTypeOf(event.sysEvent)
    const text = eventTypeOf(event.textEvent)

    // Double click exits the app
    if (
      sys === OsEventTypeList.DOUBLE_CLICK_EVENT ||
      text === OsEventTypeList.DOUBLE_CLICK_EVENT
    ) {
      await stopMicrophone()
      await bridge.shutDownPageContainer(1)
      return
    }

    const isClick =
      sys === OsEventTypeList.CLICK_EVENT ||
      text === OsEventTypeList.CLICK_EVENT

    const isUp = text === SWIPE_UP
    const isDown = text === SWIPE_DOWN
    const isLong = sys === LONG_PRESS

    if (state === 'saved') return

    if (state === 'idle') {
      if (isClick) {
        show('listening')
        await startMicrophone()
      }
    } else if (state === 'listening') {
      if (isUp) {
        show('paused')
        await stopMicrophone()
      } else if (isLong) {
        await endMeeting()
      }
    } else if (state === 'card') {
         if (isClick) {
        await approveCard(currentCard)
      } else if (isDown) {
        showNextCard()
      } else if (isLong) {
        await endMeeting()
      }
    } else if (state === 'paused') {
      if (isUp) {
        show('listening')
        await startMicrophone()
      } else if (isLong) {
        await endMeeting()
      }
    }
  })

  // Backend health check
  checkServerHealth().then((isOnline) => {
    serverStatus = isOnline ? 'OK' : 'Offline'

    if (state === 'idle') {
      show('idle')
    }
  })
}

main()