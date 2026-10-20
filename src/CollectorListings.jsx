import React, { useCallback, useEffect, useRef, useState } from 'react'
import { MessageSquare, RefreshCw, Search, Send, Tag, X } from 'lucide-react'
import { loadCollectorListings, loadListingConversation, loadListingConversations, sendListingMessage } from './lib/collectorListings'

const money = new Intl.NumberFormat('en-CA', { style: 'currency', currency: 'CAD' })

const listedDate = (value) => {
  if (!value) return ''
  try { return new Date(value).toLocaleDateString(undefined, { dateStyle: 'medium' }) } catch { return '' }
}

const messageTime = (value) => {
  if (!value) return ''
  try { return new Date(value).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) } catch { return '' }
}

const sellerLabel = (username) => (username ? `@${username}` : 'a CollectorsHub member')

// A conversation with the collector who listed an item: by the listed copy (a new one until the
// first message is sent) or by conversation id (from the Messages tab).
function ListingThread({ storeId, target, senderName, onClose, onChanged }) {
  const [conversation, setConversation] = useState(null)
  const [loaded, setLoaded] = useState(false)
  const [draft, setDraft] = useState('')
  const [sending, setSending] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const endRef = useRef(null)

  const load = useCallback(async (conversationId) => {
    try {
      const next = await loadListingConversation(storeId, { conversationId: conversationId || target.conversationId || null, copyId: target.copyId || null })
      setConversation(next)
      setError('')
    } catch (loadError) {
      setError(loadError?.message || 'Could not load this conversation.')
    } finally {
      setLoaded(true)
    }
  }, [storeId, target.conversationId, target.copyId])

  useEffect(() => { load().then(() => onChanged?.()) }, [load]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { endRef.current?.scrollIntoView({ block: 'end' }) }, [conversation?.messages?.length])

  async function send() {
    const body = draft.trim()
    if (!body || sending) return
    setSending(true)
    setError('')
    setNotice('')
    try {
      const result = await sendListingMessage(storeId, { copyId: conversation ? null : target.copyId, conversationId: conversation?.id || null, body, senderName })
      setDraft('')
      setNotice(result.emailed ? 'Sent. The collector has been emailed and can reply on CollectorsHub.' : result.emailError ? `Sent, but ${result.emailError.replace(/^The email/, 'the email')} They'll still see it on CollectorsHub.` : "Sent. The collector has email notifications off, so they'll see it next time they're on CollectorsHub.")
      await load(result.conversationId)
      onChanged?.()
    } catch (sendError) {
      setError(sendError?.message || 'Could not send the message.')
    } finally {
      setSending(false)
    }
  }

  const messages = conversation?.messages || []
  const title = conversation?.item_title || target.title || 'Listing'
  const sellerName = conversation ? conversation.collector_username : target.sellerUsername
  const seller = sellerLabel(sellerName)
  const asking = conversation?.asking_price ?? target.askingPrice
  const blocked = Boolean(conversation?.collector_blocked)
  const lastCollectorAt = [...messages].reverse().find((m) => m.sender === 'collector')?.created_at
  const inARow = messages.filter((m) => m.sender === 'store' && (!lastCollectorAt || m.created_at > lastCollectorAt)).length
  const waiting = inARow >= 3
  const closedListing = !conversation && loaded && target.stillListed === false

  return (
    <div className="cl-thread-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose() }}>
      <section className="cl-thread" role="dialog" aria-label={`Messages with ${seller}`}>
        <header>
          <div>
            <p className="cl-kicker">Message the seller</p>
            <h2>{title}</h2>
            <small>{seller}{asking != null ? ` · asking ${money.format(Number(asking))}` : ''}{conversation && !conversation.still_listed ? ' · no longer listed' : ''}</small>
          </div>
          <button type="button" className="cl-thread-close" onClick={onClose} aria-label="Close"><X size={18} /></button>
        </header>

        <div className="cl-thread-body">
          {!loaded ? <p className="cl-thread-note">Loading…</p> : null}
          {loaded && !messages.length ? (
            <p className="cl-thread-note">Ask about the item or make an offer. The collector is emailed your message and replies on CollectorsHub; their replies show up here. They never see your staff email, and you never see theirs.</p>
          ) : null}
          {messages.map((message) => (
            <div key={message.id} className={`cl-msg ${message.sender}`}>
              <p>{message.body}</p>
              <small>{message.sender === 'store' ? (message.sender_name || 'Your store') : (sellerName ? `@${sellerName}` : 'Seller')} · {messageTime(message.created_at)}</small>
            </div>
          ))}
          <div ref={endRef} />
        </div>

        {error ? <p className="cl-error">{error}</p> : null}
        {notice ? <p className="cl-notice">{notice}</p> : null}

        {blocked ? (
          <p className="cl-thread-note">This collector has stopped messages from your store.</p>
        ) : closedListing ? (
          <p className="cl-thread-note">This item is no longer listed for sale.</p>
        ) : waiting ? (
          <p className="cl-thread-note">You've sent 3 messages without a reply. You can send more once the collector replies.</p>
        ) : (
          <div className="cl-compose">
            <textarea value={draft} maxLength={2000} rows={3} placeholder={messages.length ? 'Write a reply…' : "Hi, we're interested in your listing…"} onChange={(event) => setDraft(event.target.value)}
              onKeyDown={(event) => { if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) send() }} disabled={!loaded} />
            <button type="button" onClick={send} disabled={sending || !draft.trim() || !loaded}><Send size={15} /> {sending ? 'Sending…' : 'Send'}</button>
          </div>
        )}
      </section>
    </div>
  )
}

// Copies collectors have listed for sale on CollectorsHub, marked with how many of this store's
// customers are looking for the item: buying opportunities for the store. Staff can message the
// seller; conversations are under the Messages tab.
export default function CollectorListings({ session, unreadCount = 0, onMessagesChanged }) {
  const storeId = session?.storeId
  const senderName = session?.username || session?.displayName || ''
  const [filter, setFilter] = useState('wanted')
  const [search, setSearch] = useState('')
  const [result, setResult] = useState(null)
  const [conversations, setConversations] = useState(null)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const [reload, setReload] = useState(0)
  const [thread, setThread] = useState(null)

  useEffect(() => {
    if (!storeId) return undefined
    let cancelled = false
    const timer = window.setTimeout(() => {
      setLoading(true)
      const request = filter === 'messages' ? loadListingConversations(storeId) : loadCollectorListings(storeId, { filter, search })
      request
        .then((next) => { if (cancelled) return; if (filter === 'messages') setConversations(next); else setResult(next); setError('') })
        .catch((loadError) => { if (!cancelled) setError(loadError?.message || 'Could not load collector listings.') })
        .finally(() => { if (!cancelled) setLoading(false) })
    }, filter === 'messages' ? 0 : 250)
    return () => { cancelled = true; window.clearTimeout(timer) }
  }, [storeId, filter, search, reload])

  const threadChanged = () => {
    onMessagesChanged?.()
    if (filter === 'messages') setReload((n) => n + 1)
  }

  const rows = result?.rows || []
  const showingMessages = filter === 'messages'
  const conversationRows = conversations || []
  return (
    <section className="cl-page">
      <header className="cl-head">
        <div>
          <p className="cl-kicker">Buying opportunities</p>
          <h1>Collector Listings</h1>
          <p className="cl-intro">Items collectors have listed for sale on CollectorsHub. Items your customers are looking for are marked, with the average price they'd pay. Message a seller to ask about an item or make an offer.</p>
        </div>
        <button type="button" className="cl-refresh" onClick={() => { setReload((n) => n + 1); onMessagesChanged?.() }} disabled={loading}><RefreshCw size={15} /> Refresh</button>
      </header>

      <div className="cl-filters">
        <div className="cl-tabs">
          <button type="button" className={filter === 'wanted' ? 'active' : ''} onClick={() => setFilter('wanted')}>Customers looking</button>
          <button type="button" className={filter === 'all' ? 'active' : ''} onClick={() => setFilter('all')}>All listings</button>
          <button type="button" className={showingMessages ? 'active' : ''} onClick={() => setFilter('messages')}>Messages{unreadCount ? <span className="cl-tab-badge">{unreadCount}</span> : null}</button>
        </div>
        {showingMessages ? null : <label className="cl-search"><Search size={15} /><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search item name or card number" /></label>}
        <span className="cl-count">{loading ? 'Loading…' : showingMessages ? (conversations ? `${conversationRows.length} conversation${conversationRows.length === 1 ? '' : 's'}` : '') : result ? `${rows.length} shown · ${result.totalListed} listed on CollectorsHub` : ''}</span>
      </div>

      {error ? <p className="cl-error">{error}</p> : null}

      {showingMessages && conversations && !conversationRows.length && !error ? (
        <div className="cl-empty">
          <MessageSquare size={26} />
          <strong>No messages yet</strong>
          <span>Use "Message seller" on a listing to ask about an item or make an offer. Collectors' replies show up here.</span>
        </div>
      ) : null}

      {showingMessages && conversationRows.length ? (
        <div className="cl-list">
          {conversationRows.map((row) => {
            const photo = row.frontImageUrl || row.itemImageUrl
            return (
              <button type="button" key={row.id} className={`cl-card cl-conversation${row.unread ? ' unread' : ''}`} onClick={() => setThread({ conversationId: row.id })}>
                {photo ? <img src={photo} alt="" /> : <span className="cl-noimage" />}
                <div className="cl-body">
                  <strong>{row.item_title || 'Listing'}</strong>
                  <small>{sellerLabel(row.collector_username)}{row.asking_price != null ? ` · asking ${money.format(Number(row.asking_price))}` : ''}{row.still_listed ? '' : ' · no longer listed'}{row.collector_blocked ? ' · stopped your messages' : ''}</small>
                  {row.last_body ? <span className="cl-last">{row.last_sender === 'store' ? 'You: ' : ''}{row.last_body}</span> : null}
                </div>
                <div className="cl-price">
                  {row.unread ? <span className="cl-unread">New reply</span> : <span>{row.last_sender === 'store' ? 'Awaiting reply' : 'Replied'}</span>}
                  <small>{messageTime(row.last_message_at)}</small>
                </div>
              </button>
            )
          })}
        </div>
      ) : null}

      {!showingMessages && result && !rows.length && !error ? (
        <div className="cl-empty">
          <Tag size={26} />
          <strong>{filter === 'wanted' ? 'No listings your customers are looking for' : 'No collector listings'}</strong>
          <span>{filter === 'wanted' ? 'When a collector lists an item that one of your customers has on their wishlist, it shows up here.' : 'Nothing is listed for sale on CollectorsHub right now.'}</span>
        </div>
      ) : null}

      {!showingMessages && rows.length ? (
        <div className="cl-list">
          {rows.map((row) => {
            const photo = row.frontImageUrl || row.itemImageUrl
            const grade = [row.grading_company, row.grade].filter(Boolean).join(' ')
            const title = [row.name || 'Catalogue item', row.card_number ? `#${row.card_number}` : '', row.release_year ? `(${row.release_year})` : ''].filter(Boolean).join(' ')
            return (
              <article key={row.copy_id} className={`cl-card${row.wanted_members ? ' wanted' : ''}`}>
                {photo ? <img src={photo} alt="" /> : <span className="cl-noimage" />}
                <div className="cl-body">
                  <strong>{title}</strong>
                  <small>{[row.category, grade || row.condition].filter(Boolean).join(' · ')}</small>
                  {row.wanted_members ? (
                    <span className="wanted-badge" title={row.wanted_priced ? `Average of the prices ${row.wanted_priced} of ${row.wanted_members} customer${row.wanted_members === 1 ? '' : 's'} said they'd pay.` : "None of them has set a price they'd pay yet."}>
                      ♥ {row.wanted_members} customer{row.wanted_members === 1 ? '' : 's'} looking{row.wanted_priced && row.wanted_average_price != null ? ` · avg ${money.format(Number(row.wanted_average_price))}` : ''}
                    </span>
                  ) : null}
                  <small className="cl-seller">Listed by {sellerLabel(row.seller_username)}{row.seller_area ? ` · ${row.seller_area}` : ''}{row.listed_at ? ` · ${listedDate(row.listed_at)}` : ''}</small>
                </div>
                <div className="cl-price">
                  <span>Asking</span>
                  <strong>{row.asking_price != null ? money.format(Number(row.asking_price)) : '—'}</strong>
                  <small>{row.store_in_stock ? `You have ${row.store_in_stock} in stock` : 'Not in your stock'}</small>
                  <button type="button" className="cl-message-btn" onClick={() => setThread({ copyId: row.copy_id, title, sellerUsername: row.seller_username, askingPrice: row.asking_price, stillListed: true })}><MessageSquare size={14} /> Message seller</button>
                </div>
              </article>
            )
          })}
        </div>
      ) : null}

      {thread ? <ListingThread storeId={storeId} target={thread} senderName={senderName} onClose={() => setThread(null)} onChanged={threadChanged} /> : null}
    </section>
  )
}
