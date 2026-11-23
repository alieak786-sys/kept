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