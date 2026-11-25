import { checkServerHealth, getDeviceId, startPairing, deleteMyData } from './api.js'
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
// Shown on the glasses; the user opens this page on their phone (change when we deploy)
const PAIR_PAGE = 'localhost:3000/pair'
const DUPLICATE_WINDOW_MS = 60000 // same promise within 60 s is treated as a duplicate

// 16 kHz x 2 bytes x 10 seconds
const AUDIO_CHUNK_BYTES = 320000
const AUDIO_HOP_BYTES = AUDIO_CHUNK_BYTES / 2 // 5 seconds
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
  const deviceId = getDeviceId()
  let paired = false
  let pairCode = ''

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

  // Counters for the end-of-meeting summary
  let stats = { caught: 0, added: 0, skipped: 0 }

  function resetStats() {
    stats = { caught: 0, added: 0, skipped: 0 }
  }

  function getScreenContent(screen) {
    if (screen === 'idle') {
      const calendarLines = paired
        ? 'Calendar: linked'
        : `Calendar: not linked\nOpen ${PAIR_PAGE}\nCode: ${pairCode || '...'}`
      const deleteLine = paired ? '\nSwipe up: delete my data' : ''
      return `Kept | Server: ${serverStatus}\n${calendarLines}\nTap to start meeting${deleteLine}\nDouble tap to exit`
    }

    if (screen === 'listening') {
      const bufferedSeconds = (
        audioBufferOffset / AUDIO_BYTES_PER_SECOND
      ).toFixed(1)

      return `* Listening | Mic: ${microphoneStatus}\nSent: ${uploadedChunkCount} | ${uploadStatus} | Buffer ${bufferedSeconds}s\nHeard: ${lastHeard || '-'}\nPromises: ${lastPromises}\nSwipe up: pause\nHold: end meeting`
    }

    if (screen === 'card') {
      return currentCard ? cardText(currentCard) : 'No card'
    }

    if (screen === 'confirmDelete') {
      return 'Delete my data?\n\nUnlinks Google Calendar\nand erases the saved login.\n\nTap = delete\nSwipe down = cancel'
    }

    if (screen === 'summary') {
      const leftOver = stats.caught - stats.added - stats.skipped
      const leftLine = leftOver > 0 ? `\nLeft over: ${leftOver}` : ''
      return `Meeting ended\n\nPromises caught: ${stats.caught}\nAdded: ${stats.added} | Skipped: ${stats.skipped}${leftLine}\n\nTap to continue`
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
      stats.caught++
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

  // Saves the approved promise: Notion task, plus a Calendar event if the glasses are paired
  async function approveCard(card) {
    saveMessage = 'Saving...\nNotion'
    show('saved')

    try {
      const response = await fetch(APPROVE_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...card, deviceId }),
      })
      const data = await response.json()
      if (!response.ok || !data.ok) throw new Error(`HTTP ${response.status}`)

      saveMessage = data.calendar?.created
        ? 'Saved\nNotion + Calendar'
        : 'Saved\nNotion only'
      stats.added++
    } catch (error) {
      console.error('Save failed:', error)
      saveMessage = 'Save failed\nCheck server'
    }

    if (state === 'saved') show('saved')
    setTimeout(() => {
      if (state === 'saved') showNextCard()
    }, 1500)
  }
  
  // Erases the saved Google login and unlinks these glasses
  async function deleteData() {
    saveMessage = 'Deleting...'
    show('saved')

    try {
      await deleteMyData(deviceId)
      paired = false
      pairCode = ''
      saveMessage = 'Data deleted\nCalendar unlinked'
    } catch (error) {
      console.error('Delete failed:', error)
      saveMessage = 'Delete failed\nCheck server'
    }

    show('saved')
    setTimeout(async () => {
      await refreshPairing()
      if (state === 'saved') show('idle')
    }, 2000)
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

// Upload overlapping 10-second windows every 5 seconds
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

    if (audioBufferOffset === AUDIO_CHUNK_BYTES) {
      // Copy the completed window before reusing the buffer
      const completedChunk = audioBuffer.slice()

      // Retain the last 5 seconds for the next overlapping window
      audioBuffer.copyWithin(0, AUDIO_HOP_BYTES)
      audioBufferOffset = AUDIO_HOP_BYTES

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
    show('summary')
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
        resetStats()
        show('listening')
        await startMicrophone()
      } else if (isUp && paired) {
        show('confirmDelete')
      }
    } else if (state === 'confirmDelete') {
      if (isClick) {
        await deleteData()
      } else if (isDown) {
        show('idle')
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
        stats.skipped++
        showNextCard()
      } else if (isLong) {
        await endMeeting()
      }
    } else if (state === 'summary') {
      if (isClick) show('idle')
    } else if (state === 'paused') {
      if (isUp) {
        show('listening')
        await startMicrophone()
      } else if (isLong) {
        await endMeeting()
      }
    }
  })

  // Asks the server for a pairing code, or learns that we are already paired
  async function refreshPairing() {
    const wasPaired = paired
    const oldCode = pairCode

    try {
      const data = await startPairing(deviceId)
      paired = Boolean(data.paired)
      pairCode = data.code || ''
    } catch (error) {
      console.error('Pairing check failed:', error)
    }

    if (state === 'idle' && (paired !== wasPaired || pairCode !== oldCode)) {
      show('idle')
    }
  }

  // Backend health check, then pairing check
  checkServerHealth().then(async (isOnline) => {
    serverStatus = isOnline ? 'OK' : 'Offline'

    if (state === 'idle') {
      show('idle')
    }

    if (isOnline) await refreshPairing()
  })

  // While not paired, keep the code fresh and notice when pairing is done
  setInterval(() => {
    if (serverStatus === 'OK' && !paired && state === 'idle') refreshPairing()
  }, 5000)
}

main()