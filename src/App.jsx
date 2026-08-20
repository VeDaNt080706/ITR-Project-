import { useState, useEffect, useRef, useCallback } from 'react'
import Auth from './Auth'
import { getSupabaseClient } from './supabaseClient'

const EVENT_TYPES = ['create', 'copy', 'move', 'rename', 'delete', 'modify']

const getInitialStats = () => ({
  total: 0,
  create: 0,
  copy: 0,
  move: 0,
  rename: 0,
  delete: 0,
  modify: 0,
})

export default function App() {
  const [user, setUser] = useState(null)
  const [authLoading, setAuthLoading] = useState(true)

  const [tracking, setTracking] = useState(false)
  const [connected, setConnected] = useState(false)
  const [reconnecting, setReconnecting] = useState(false)
  const [logs, setLogs] = useState([])
  const [stats, setStats] = useState(getInitialStats())
  const [bumpKey, setBumpKey] = useState(null)
  const [toast, setToast] = useState(null)

  const wsRef = useRef(null)
  const reconnectTimer = useRef(null)
  const reconnectAttempts = useRef(0)
  const logEndRef = useRef(null)
  const logContainerRef = useRef(null)
  const autoScroll = useRef(true)
  const toastTimer = useRef(null)
  const recentEventsRef = useRef(new Map())

  // ── Show Toast Notification (Upper Middle) ──
  const showToast = useCallback((type, title, desc) => {
    if (toastTimer.current) clearTimeout(toastTimer.current)
    setToast({ type, title, desc })
    toastTimer.current = setTimeout(() => {
      setToast(null)
    }, 3200)
  }, [])

  // ── Supabase Auth Check ──
  useEffect(() => {
    const supabase = getSupabaseClient()
    if (!supabase) {
      setAuthLoading(false)
      return
    }

    supabase.auth.getSession().then(({ data: { session } }) => {
      setUser(session?.user ?? null)
      setAuthLoading(false)
    }).catch(() => {
      setAuthLoading(false)
    })

    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, session) => {
      const nextUser = session?.user ?? null
      setUser(nextUser)
      setAuthLoading(false)
    })

    return () => {
      subscription.unsubscribe()
    }
  }, [])

  // ── Clean slate on login ──
  useEffect(() => {
    setLogs([])
    setStats(getInitialStats())
    recentEventsRef.current.clear()
  }, [user?.id])

  // ── Frontend Event Deduplication Check ──
  const isDuplicate = useCallback((event) => {
    const type = (event.type || '').toUpperCase()
    const target = event.file || event.destination || event.source || ''
    const key = `${type}:${target.toLowerCase()}`
    const now = Date.now()
    const lastTime = recentEventsRef.current.get(key)

    if (lastTime && now - lastTime < 1500) {
      return true
    }
    recentEventsRef.current.set(key, now)

    if (recentEventsRef.current.size > 200) {
      for (const [k, v] of recentEventsRef.current.entries()) {
        if (now - v > 5000) recentEventsRef.current.delete(k)
      }
    }
    return false
  }, [])

  // ── WebSocket Connection ──
  const connectWS = useCallback(() => {
    if (!user) return

    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
    const ws = new WebSocket(`${protocol}//${window.location.host}/ws`)

    ws.onopen = () => {
      reconnectAttempts.current = 0
      setConnected(true)
      setReconnecting(false)
      fetch('/api/status').then(r => r.json()).then(d => setTracking(d.tracking)).catch(() => {})
    }

    ws.onmessage = (evt) => {
      try {
        const event = JSON.parse(evt.data)
        
        if (event.type === 'STATUS') {
          setTracking(event.tracking)
          return
        }

        const type = (event.type || '').toLowerCase()
        if (!EVENT_TYPES.includes(type)) {
          return
        }

        if (isDuplicate(event)) {
          return
        }

        setStats(prev => {
          const next = { ...prev }
          next.total = prev.total + 1
          if (next[type] !== undefined) next[type] = prev[type] + 1
          return next
        })
        setBumpKey(type)
        setTimeout(() => setBumpKey(null), 250)

        setLogs(prev => {
          const next = [...prev, { ...event, id: Date.now() + Math.random() }]
          return next.length > 500 ? next.slice(-500) : next
        })
      } catch (e) { /* ignore parse errors */ }
    }

    ws.onclose = () => {
      setConnected(false)
      setReconnecting(true)
      const delay = Math.min(1000 * Math.pow(2, reconnectAttempts.current), 10000)
      reconnectAttempts.current++
      reconnectTimer.current = setTimeout(connectWS, delay)
    }

    ws.onerror = () => ws.close()
    wsRef.current = ws
  }, [user, isDuplicate])

  useEffect(() => {
    if (user) {
      connectWS()
    } else {
      if (wsRef.current) wsRef.current.close()
      if (reconnectTimer.current) clearTimeout(reconnectTimer.current)
      setConnected(false)
      setReconnecting(false)
    }
    return () => {
      if (wsRef.current) wsRef.current.close()
      if (reconnectTimer.current) clearTimeout(reconnectTimer.current)
    }
  }, [user, connectWS])

  // ── Auto-scroll ──
  useEffect(() => {
    if (autoScroll.current && logEndRef.current) {
      logEndRef.current.scrollIntoView({ behavior: 'smooth' })
    }
  }, [logs])

  const handleScroll = () => {
    const el = logContainerRef.current
    if (!el) return
    autoScroll.current = el.scrollHeight - el.scrollTop - el.clientHeight < 150
  }

  // ── Toggle Tracking with Toast Notification ──
  const handleToggle = async () => {
    try {
      const res = await fetch('/api/toggle', { method: 'POST' })
      const data = await res.json()
      setTracking(data.tracking)

      if (data.tracking) {
        showToast('on', 'Tracking ON', 'Live file monitoring is now active and recording changes.')
      } else {
        showToast('off', 'Tracking OFF', 'File monitoring has been paused.')
      }
    } catch (e) {
      console.error('Toggle failed:', e)
    }
  }

  // ── Clear Logs ──
  const handleClear = () => {
    setLogs([])
    setStats(getInitialStats())
    recentEventsRef.current.clear()
  }

  // ── Sign Out ──
  const handleSignOut = async () => {
    if (tracking) {
      await handleToggle()
    }
    const supabase = getSupabaseClient()
    if (supabase) {
      await supabase.auth.signOut()
    }
    setUser(null)
    setLogs([])
    setStats(getInitialStats())
  }

  // Initial Auth Loading Screen
  if (authLoading) {
    return (
      <div className="auth-loading-screen">
        <div className="spinner large"></div>
        <p>Initializing secure session...</p>
      </div>
    )
  }

  // If not logged in, render Auth (Sign In / Sign Up)
  if (!user) {
    return <Auth onAuthSuccess={(authenticatedUser) => setUser(authenticatedUser)} />
  }

  const connectionState = connected ? 'connected' : reconnecting ? 'reconnecting' : 'disconnected'
  const connectionLabel = connected ? 'Connected' : reconnecting ? 'Reconnecting...' : 'Disconnected'

  return (
    <div className="app">
      {/* ── Toast Notification Popup (Upper Middle) ── */}
      {toast && (
        <div className={`toast-notification ${toast.type}`}>
          <div className="toast-icon">
            {toast.type === 'on' ? (
              <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="20 6 9 17 4 12"></polyline>
              </svg>
            ) : (
              <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <rect x="6" y="4" width="4" height="16"></rect>
                <rect x="14" y="4" width="4" height="16"></rect>
              </svg>
            )}
          </div>
          <div className="toast-content">
            <div className="toast-title">{toast.title}</div>
            <div className="toast-desc">{toast.desc}</div>
          </div>
          <button className="toast-close" onClick={() => setToast(null)}>×</button>
        </div>
      )}

      {/* ── Header ── */}
      <header className="header">
        <div className="header-left">
          <svg className="logo-icon" width="34" height="34" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M13 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/>
            <polyline points="13 2 13 9 20 9"/>
          </svg>
          <div>
            <h1>ITR File Monitor</h1>
          </div>
        </div>

        <div className="header-right">
          {/* User Email Badge */}
          <div className="user-profile-badge" title={`Signed in as ${user.email}`}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"></path>
              <circle cx="12" cy="7" r="4"></circle>
            </svg>
            <span className="user-email-text">{user.email}</span>
          </div>

          <div className={`status-badge ${connectionState}`}>
            <span className="status-dot" />
            <span className="status-text">{connectionLabel}</span>
          </div>

          <div className="toggle-wrapper">
            <span className={`toggle-label ${tracking ? 'active' : ''}`}>
              {tracking ? 'Tracking On' : 'Tracking Off'}
            </span>
            <button
              className={`toggle-btn ${tracking ? 'active' : ''}`}
              onClick={handleToggle}
              role="switch"
              aria-checked={tracking}
              aria-label="Toggle tracking"
            >
              <span className="toggle-knob" />
            </button>
          </div>

          <button className="signout-btn" onClick={handleSignOut} title="Sign Out">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"></path>
              <polyline points="16 17 21 12 16 7"></polyline>
              <line x1="21" y1="12" x2="9" y2="12"></line>
            </svg>
            <span>Sign Out</span>
          </button>
        </div>
      </header>

      {/* ── Stats ── */}
      <section className="stats-bar">
        <div className={`stat-card ${bumpKey === 'total' || bumpKey ? 'bump' : ''}`}>
          <div className="stat-value">{stats.total}</div>
          <div className="stat-label">Total</div>
        </div>
        {EVENT_TYPES.map(type => (
          <div key={type} className={`stat-card ${bumpKey === type ? 'bump' : ''}`}>
            <div className="stat-value">{stats[type]}</div>
            <div className="stat-label">{type.charAt(0).toUpperCase() + type.slice(1) + 's'}</div>
          </div>
        ))}
      </section>

      {/* ── Log Feed ── */}
      <section className="log-feed">
        <div className="section-header">
          <h2>Live Event Feed</h2>
          <button className="action-btn" onClick={handleClear} title="Clear history for this session">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>
            </svg>
            Clear History
          </button>
        </div>

        <div className="log-container" ref={logContainerRef} onScroll={handleScroll}>
          {logs.length === 0 ? (
            <div className="empty-state">
              <svg width="60" height="60" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1" strokeLinecap="round" strokeLinejoin="round" opacity="0.25">
                <circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/>
              </svg>
              <p>No events recorded. Turn the toggle ON to start tracking file system activity.</p>
            </div>
          ) : (
            <div className="log-list">
              {logs.map((event) => {
                const type = (event.type || 'INFO').toUpperCase()
                const hasSourceDest = (type === 'MOVE' || type === 'COPY') && (event.source && event.destination)

                if (hasSourceDest) {
                  return (
                    <div key={event.id} className={`log-entry log-entry-transfer ${event.isExternal ? 'external' : ''}`}>
                      <span className="log-timestamp">{event.timestamp}</span>

                      {/* Left: Source File */}
                      <div className="log-path-card source-card" title={event.source}>
                        <span className="path-chip source-chip">SOURCE</span>
                        <span className="path-text">{event.source}</span>
                      </div>

                      {/* Center: Action Badge with Arrow */}
                      <div className="transfer-action-col">
                        <span className="log-type-badge" data-type={type}>{type}</span>
                        <svg className="transfer-arrow" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                          <line x1="5" y1="12" x2="19" y2="12"></line>
                          <polyline points="12 5 19 12 12 19"></polyline>
                        </svg>
                      </div>

                      {/* Right: Destination File */}
                      <div className="log-path-card destination-card" title={event.destination}>
                        <span className="path-chip destination-chip">DESTINATION</span>
                        <span className="path-text">{event.destination}</span>
                      </div>

                      {/* Trailing: Size & External badge */}
                      <div className="log-trailing-info">
                        {event.size && <span className="log-size">{event.size}</span>}
                        {event.isExternal && <span className="usb-badge">USB</span>}
                      </div>
                    </div>
                  )
                }

                // Single Target Operation (CREATE, DELETE, MODIFY, RENAME)
                const targetPath = event.file || event.destination || event.source || ''
                return (
                  <div key={event.id} className={`log-entry log-entry-single ${event.isExternal ? 'external' : ''}`}>
                    <span className="log-timestamp">{event.timestamp}</span>
                    <span className="log-type-badge" data-type={type}>{type}</span>

                    <div className="log-path-card single-card" title={targetPath}>
                      <span className="path-chip target-chip">
                        {type === 'DELETE' ? 'DELETED' : type === 'CREATE' ? 'NEW FILE' : type === 'MODIFY' ? 'MODIFIED' : 'FILE'}
                      </span>
                      <span className="path-text">{targetPath}</span>
                      {event.message && <span className="path-meta">{event.message}</span>}
                    </div>

                    <div className="log-trailing-info">
                      {event.size && <span className="log-size">{event.size}</span>}
                      {event.isExternal && <span className="usb-badge">USB</span>}
                    </div>
                  </div>
                )
              })}
              <div ref={logEndRef} />
            </div>
          )}
        </div>
      </section>
    </div>
  )
}
