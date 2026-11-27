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

const API_URL = 'https://kept-production-9765f151.up.railway.app/api/audio'
const APPROVE_URL = 'https://kept-production-9765f151.up.railway.app/api/cards/approve'
const PREVIEW_URL = 'https://kept-production-9765f151.up.railway.app/api/cards/preview'
const PAIR_PAGE = 'kept-production-9765f151.up.railway.app/pair'
const DUPLICATE_WINDOW_MS = 60000 // same promise within 60 s is treated as a duplicate

// 16 kHz x 2 bytes x 10 seconds
const AUDIO_CHUNK_BYTES = 320000
const AUDIO_HOP_BYTES = AUDIO_CHUNK_BYTES / 2 // 5 seconds
const AUDIO_BYTES_PER_SECOND = 32000
const RECENT_BYTES = AUDIO_BYTES_PER_SECOND * 30 // last 30 seconds, for the manual check

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

  // Last 30 seconds of audio, for the manual "check now" tap
  let recentChunks = []
  let recentBytes = 0

  // Short message shown on the listening screen (for example "Nothing new found")
  let notice = ''

  // Keep uploads in order
  let uploadQueue = Promise.resolve()

  // Promise cards
  let currentCard = null
  let pendingCards = []
  let saveMessage = ''

  // Calendar information for the promise currently being reviewed
  let currentCalendarPreview = null
  let reviewPageIndex = 0
  const CALENDAR_EVENTS_PER_PAGE = 2
  const seenKeys = new Map() // promise key -> time it was shown

  // Counters for the end-of-meeting summary
  let stats = { caught: 0, added: 0, skipped: 0 }

  function resetStats() {
    stats = { caught: 0, added: 0, skipped: 0 }
  }

    function formatCalendarEventTime(event) {
    if (event.allDay) return 'All day'
    if (!event.start) return ''

    const date = new Date(event.start)

    if (Number.isNaN(date.getTime())) return ''

    return date.toLocaleTimeString('en-GB', {
      hour: '2-digit',
      minute: '2-digit',
      timeZone: 'Asia/Karachi',
    })
  }

  function reviewText() {
    if (!currentCard) return 'No promise to review'

    const preview = currentCalendarPreview || {
      status: 'failed',
      events: [],
      duplicate: null,
    }

    const events = Array.isArray(preview.events)
      ? preview.events
      : []

    const totalPages = Math.max(
      1,
      Math.ceil(events.length / CALENDAR_EVENTS_PER_PAGE),
    )

    const startIndex = reviewPageIndex * CALENDAR_EVENTS_PER_PAGE

    const pageEvents = events.slice(
      startIndex,
      startIndex + CALENDAR_EVENTS_PER_PAGE,
    )

    const lines = [
      `Promise: ${capitalise(currentCard.task).slice(0, 55)}`,
      `Due: ${formatDue(currentCard.due)}`,
    ]

    if (preview.status === 'checked') {
      const duplicate = preview.duplicate
      const matchedEvent =
        duplicate?.isDuplicate &&
        Number.isInteger(duplicate.matchingEventIndex)
          ? events[duplicate.matchingEventIndex]
          : null

      if (duplicate?.isDuplicate) {
        lines.push(
          `Possible duplicate: ${(matchedEvent?.title || 'Yes').slice(0, 32)}`,
        )
      } else {
        lines.push('Possible duplicate: not detected')
      }

      lines.push('Existing plans:')

      if (events.length === 0) {
        lines.push('None on this date')
      } else {
        for (let i = 0; i < pageEvents.length; i++) {
          const event = pageEvents[i]
          const eventNumber = startIndex + i + 1
          const eventTime = formatCalendarEventTime(event)

          lines.push(
            `${eventNumber}. ${String(event.title || 'Untitled').slice(0, 29)} ${eventTime}`,
          )
        }
      }
    } else if (preview.status === 'not_connected') {
      lines.push('Calendar is not linked')
      lines.push('Existing plans unavailable')
    } else if (preview.status === 'no_due_date') {
      lines.push('No due date to check')
    } else {
      lines.push('Calendar check unavailable')
      lines.push('Existing plans could not be loaded')
    }

    if (totalPages > 1) {
      lines.push(`Plans page: ${reviewPageIndex + 1}/${totalPages}`)
    }

    if (reviewPageIndex < totalPages - 1) {
      lines.push('Tap = next plans')
    } else {
      lines.push('Tap = add to Notion')
    }

    lines.push('Swipe down = skip')

return lines.join('\n')
  }
  function getScreenContent(screen) {
    if (screen === 'idle') {
      const calendarLines = paired
        ? 'Calendar: linked'
        : `Calendar: not linked\nOpen ${PAIR_PAGE}\nCode: ${pairCode || '...'}`
      const deleteLine = paired ? '\nSwipe up: delete my data' : ''
      return `VowGlass | Server: ${serverStatus}\n${calendarLines}\nTap to start meeting${deleteLine}\nDouble tap to exit`
    }

    if (screen === 'listening') {
      const bufferedSeconds = (
        audioBufferOffset / AUDIO_BYTES_PER_SECOND
      ).toFixed(1)

      return `* Listening | Mic: ${microphoneStatus}\nSent: ${uploadedChunkCount} | ${uploadStatus} | Buffer ${bufferedSeconds}s\n${notice || `Heard: ${lastHeard || '-'}`}\nPromises: ${lastPromises}\nTap: check last 30 s\nSwipe up: pause\nHold: end meeting`
    }

    if (screen === 'checkingCalendar') {
      return `Promise detected\n${currentCard ? capitalise(currentCard.task).slice(0, 55) : ''}\nDue: ${formatDue(currentCard?.due)}\n\nChecking Calendar...\nHold: end meeting`
    }

    if (screen === 'review') {
      return reviewText()
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

  // Shows a short message on the listening screen for a few seconds
  function showNotice(text, ms = 3000) {
    notice = text
    if (state === 'listening') show('listening')

    setTimeout(() => {
      if (notice === text) {
        notice = ''
        if (state === 'listening') show('listening')
      }
    }, ms)
  }

  // ---- Promise cards ----

  async function showNextCard() {
    currentCard = pendingCards.shift() || null
    currentCalendarPreview = null
    reviewPageIndex = 0

    if (!currentCard) {
      show('listening')
      return
    }

    const cardBeingChecked = currentCard

    // Display a loading screen while Calendar is checked.
    show('checkingCalendar')

    try {
      const response = await fetch(PREVIEW_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          ...cardBeingChecked,
          deviceId,
        }),
      })

      const data = await response.json()

      if (!response.ok || !data.ok) {
        throw new Error(`Calendar preview HTTP ${response.status}`)
      }

      currentCalendarPreview = data.calendar || {
        status: 'failed',
        events: [],
        duplicate: null,
      }
    } catch (error) {
      console.error('Calendar preview request failed:', error)

      currentCalendarPreview = {
        status: 'failed',
        events: [],
        duplicate: null,
      }
    }

    // Do not display an old result if the meeting was ended meanwhile.
    if (
      currentCard !== cardBeingChecked ||
      state !== 'checkingCalendar'
    ) {
      return
    }

    show('review')
  }

  // Adds new cards to the queue. Returns how many were new.
  function enqueueCards(list) {
    // Cards only matter while a meeting is running
    if (
      state !== 'listening' &&
      state !== 'checkingCalendar' &&
      state !== 'review' &&
      state !== 'saved'
    ) return 0

    let added = 0
    for (const card of list) {
      const key = cardKey(card)
      const lastSeen = seenKeys.get(key)
      if (lastSeen && Date.now() - lastSeen < DUPLICATE_WINDOW_MS) continue
      seenKeys.set(key, Date.now())
      pendingCards.push(card)
      stats.caught++
      added++
    }

    if (state === 'listening' && pendingCards.length > 0) {
      showNextCard()
    }
    return added
  }

  function clearCards() {
    currentCard = null
    pendingCards = []
    currentCalendarPreview = null
    reviewPageIndex = 0
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

      const saved = ['Notion']
      if (data.calendar?.created) saved.push('Calendar')
      if (data.gmail?.created) saved.push('Gmail draft')
      saveMessage = `Saved\n${saved.join(' + ')}`
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

  // Discard incomplete audio when capture starts or stops
  function resetAudioBuffer() {
    audioBuffer = new Uint8Array(AUDIO_CHUNK_BYTES)
    audioBufferOffset = 0
    recentChunks = []
    recentBytes = 0
  }

  // Keeps roughly the last 30 seconds of audio in memory (never saved to disk)
  function rememberRecent(pcm) {
    recentChunks.push(pcm.slice())
    recentBytes += pcm.length

    while (
      recentChunks.length > 1 &&
      recentBytes - recentChunks[0].length >= RECENT_BYTES
    ) {
      recentBytes -= recentChunks.shift().length
    }
  }

  // Manual fallback: send the last 30 seconds right now
  function checkLastThirtySeconds() {
    if (recentBytes < AUDIO_BYTES_PER_SECOND * 3) {
      showNotice('Not enough audio yet')
      return
    }

    const clip = new Uint8Array(recentBytes)
    let offset = 0
    for (const piece of recentChunks) {
      clip.set(piece, offset)
      offset += piece.length
    }
    const lastPart =
      clip.length > RECENT_BYTES ? clip.subarray(clip.length - RECENT_BYTES) : clip

    showNotice('Checking last 30 s...', 15000)
    uploadAudioChunk(lastPart, { manual: true })
  }

  // Upload one audio clip (manual = true when the user tapped "check last 30 s")
  function uploadAudioChunk(chunk, { manual = false } = {}) {
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

      const added = Array.isArray(data.commitments)
        ? enqueueCards(data.commitments)
        : 0

      if (manual && added === 0) showNotice('Nothing new found')

      // Refresh the counters if we are still on the listening screen
      if (state === 'listening') {
        show('listening')
      }
    }).catch((error) => {
      uploadStatus = 'FAILED'
      console.error('Audio upload error:', error)

      if (manual) showNotice('Check failed')

      if (state === 'listening') {
        show('listening')
      }
    })
  }

  // Upload overlapping 10-second windows every 5 seconds
  function bufferAudio(pcm) {
    rememberRecent(pcm)

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
    notice = ''
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
      if (isClick) {
        checkLastThirtySeconds()
      } else if (isUp) {
        show('paused')
        await stopMicrophone()
      } else if (isLong) {
        await endMeeting()
      }
    } else if (state === 'checkingCalendar') {
      if (isLong) {
        await endMeeting()
      }
    } else if (state === 'review') {
      if (isClick) {
        const eventCount = Array.isArray(currentCalendarPreview?.events)
          ? currentCalendarPreview.events.length
          : 0

        const totalPages = Math.max(
          1,
          Math.ceil(eventCount / CALENDAR_EVENTS_PER_PAGE),
        )

        // The user must review every page before the final Add action.
        if (reviewPageIndex < totalPages - 1) {
          reviewPageIndex++
          show('review')
        } else {
          await approveCard(currentCard)
        }
      } else if (isDown) {
        stats.skipped++
        await showNextCard()
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