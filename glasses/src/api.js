const API_BASE_URL = 'http://localhost:3000'

export async function checkServerHealth() {
  try {
    const response = await fetch(`${API_BASE_URL}/api/health`)

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`)
    }

    const data = await response.json()
    return data.ok === true
  } catch (error) {
    console.error('Kept backend health check failed:', error)
    return false
  }
}

// A random id that identifies this pair of glasses to the server
export function getDeviceId() {
  const key = 'kept_device_id'

  try {
    const saved = window.localStorage.getItem(key)
    if (saved) return saved
  } catch {
    // storage may be unavailable
  }

  const bytes = new Uint8Array(16)
  window.crypto.getRandomValues(bytes)
  const id = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')

  try {
    window.localStorage.setItem(key, id)
  } catch {
    // ignore: we will just get a new id next time
  }
  return id
}

// Asks the server for a pairing code (or tells us we are already paired)
export async function startPairing(deviceId) {
  const response = await fetch(`${API_BASE_URL}/api/pair/start`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ deviceId }),
  })
  const data = await response.json()

  if (!response.ok || !data.ok) {
    throw new Error(`HTTP ${response.status}`)
  }
  return data
}


// Asks the server to erase this user's saved login and unlink the glasses
export async function deleteMyData(deviceId) {
  const response = await fetch(`${API_BASE_URL}/api/data/delete`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ deviceId }),
  })
  const data = await response.json()

  if (!response.ok || !data.ok) {
    throw new Error(`HTTP ${response.status}`)
  }
  return data
}