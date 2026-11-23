import {
  waitForEvenAppBridge,
  TextContainerProperty,
  CreateStartUpPageContainer,
  TextContainerUpgrade,
  OsEventTypeList,
} from '@evenrealities/even_hub_sdk'

// Gesture numbers we measured in the simulator
const SWIPE_UP = 1 // arrives in event.textEvent
const SWIPE_DOWN = 2 // arrives in event.textEvent
const LONG_PRESS = 10 // arrives in event.sysEvent

// What each screen shows (max about 3-5 short lines)
const SCREENS = {
  idle: 'Kept\n\nTap to start meeting\nDouble tap to exit',
  listening: '* Listening\n\nTap: check last 30 s\nSwipe up: pause\nHold: end meeting',
  card: 'Send report to Ali\nDue: Friday\n\nTap = add\nSwipe down = skip',
  saved: 'Saved\nNotion + Calendar',
  paused: 'Paused\n\nSwipe up: resume\nHold: end meeting',
}

async function main() {
  const bridge = await waitForEvenAppBridge()
  let state = 'idle'

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
    content: SCREENS.idle,
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
        content: SCREENS[newState],
      }),
    )
  }

  // A tap arrives as eventType undefined, so we treat "undefined" as CLICK.
  function eventTypeOf(envelope) {
    if (!envelope) return null
    return envelope.eventType ?? OsEventTypeList.CLICK_EVENT
  }

  bridge.onEvenHubEvent((event) => {
    const sys = eventTypeOf(event.sysEvent)
    const text = eventTypeOf(event.textEvent)

    // Double tap always exits the app (platform rule)
    if (sys === OsEventTypeList.DOUBLE_CLICK_EVENT || text === OsEventTypeList.DOUBLE_CLICK_EVENT) {
      bridge.shutDownPageContainer(1)
      return
    }

    const isClick = sys === OsEventTypeList.CLICK_EVENT || text === OsEventTypeList.CLICK_EVENT
    const isUp = text === SWIPE_UP
    const isDown = text === SWIPE_DOWN
    const isLong = sys === LONG_PRESS

    if (state === 'saved') return // ignore gestures while "Saved" is showing

    if (state === 'idle') {
      if (isClick) show('listening')
    } else if (state === 'listening') {
      if (isClick) show('card') // later: real "check last 30 s"
      else if (isUp) show('paused')
      else if (isLong) show('idle')
    } else if (state === 'card') {
      if (isClick) {
        show('saved')
        setTimeout(() => show('listening'), 2000)
      } else if (isDown) {
        show('listening')
      }
    } else if (state === 'paused') {
      if (isUp) show('listening')
      else if (isLong) show('idle')
    }
  })
}

main()