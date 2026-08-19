import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AztecAddress } from '@aztec/aztec.js/addresses';
import type { EmbeddedWallet } from '@aztec/wallets/embedded';
import type { PrivAZyContract } from './generated/PrivAZy';
import { registerSponsoredFPC } from './fees';
import { PRIVAZY_CONTRACT_ADDRESS } from './config';
import { createWallet, createSessionAccount } from './wallet';
import {
  attachToPrivAZy,
  getInbox,
  getOutbox,
  sendMessage,
  MAX_CONTENT_BYTES,
  textByteLength,
  isValidAddress,
  type InboxMessage,
  type OutboxMessage,
} from './privazy';
import './App.css';

const MAX_TEXT = MAX_CONTENT_BYTES;

type LogLine = { time: string; text: string; err?: boolean };

type ChatMessage = {
  id: string;
  dir: 'in' | 'out';
  peer: string;
  content: string;
  timestamp: number;
};

function shortAddress(addr: string, n = 10) {
  return addr.length > n * 2 ? `${addr.slice(0, n)}…${addr.slice(-n)}` : addr;
}

function formatTime(ts: number): string {
  if (!ts) return '';
  const d = new Date(ts * 1000);
  return d.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function App() {
  const [account, setAccount] = useState<AztecAddress | null>(null);
  const [contract, setContract] = useState<PrivAZyContract | null>(null);
  const [inbox, setInbox] = useState<InboxMessage[]>([]);
  const [outbox, setOutbox] = useState<OutboxMessage[]>([]);
  const [activePeer, setActivePeer] = useState<string | null>(null);
  const [newPeer, setNewPeer] = useState('');
  const [draft, setDraft] = useState('');
  const [status, setStatus] = useState('');
  const [error, setError] = useState('');
  const [connecting, setConnecting] = useState(false);
  const [sending, setSending] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [log, setLog] = useState<LogLine[]>([]);
  const logRef = useRef<HTMLDivElement>(null);
  const threadRef = useRef<HTMLDivElement>(null);
  const readRef = useRef<Record<string, number>>({});

  function addLog(text: string, err = false) {
    setLog((l) => [
      ...l.slice(-99),
      { time: new Date().toLocaleTimeString(), text, err },
    ]);
  }

  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight });
  }, [log]);

  useEffect(() => {
    threadRef.current?.scrollTo({ top: threadRef.current.scrollHeight });
  }, [activePeer, inbox, outbox]);

  const refreshMessages = useCallback(
    async (c?: PrivAZyContract | null, a?: AztecAddress) => {
      const cc = c ?? contract;
      const aa = a ?? account;
      if (!cc || !aa) return;
      setRefreshing(true);
      try {
        const [msgs, sent] = await Promise.all([
          getInbox(cc, aa),
          getOutbox(cc, aa),
        ]);
        setInbox(msgs);
        setOutbox(sent);
        const total = msgs.length + sent.length;
        addLog(
          `Synced · ${msgs.length} received, ${sent.length} sent (${total} total)`,
        );
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        setError(`Sync failed: ${msg}`);
        addLog(`Sync error: ${msg}`, true);
      } finally {
        setRefreshing(false);
      }
    },
    [contract, account],
  );

  const conversations = useMemo(() => {
    const map = new Map<string, ChatMessage[]>();
    inbox.forEach((m, i) => {
      const peer = m.sender;
      const arr = map.get(peer) ?? [];
      arr.push({
        id: `in-${peer}-${i}`,
        dir: 'in',
        peer,
        content: m.content,
        timestamp: m.timestamp,
      });
      map.set(peer, arr);
    });
    outbox.forEach((m, i) => {
      const peer = m.recipient;
      const arr = map.get(peer) ?? [];
      arr.push({
        id: `out-${peer}-${i}`,
        dir: 'out',
        peer,
        content: m.content,
        timestamp: m.timestamp,
      });
      map.set(peer, arr);
    });
    return Array.from(map.entries())
      .map(([peer, messages]) => {
        const sorted = [...messages].sort(
          (a, b) => a.timestamp - b.timestamp,
        );
        const received = messages.filter((m) => m.dir === 'in').length;
        const read = readRef.current[peer] ?? 0;
        const unread = Math.max(0, received - read);
        const last = sorted[sorted.length - 1];
        return { peer, messages: sorted, received, unread, last };
      })
      .sort((a, b) => (b.last?.timestamp ?? 0) - (a.last?.timestamp ?? 0));
  }, [inbox, outbox]);

  const activeMessages = useMemo(() => {
    if (!activePeer) return [];
    return conversations.find((c) => c.peer === activePeer)?.messages ?? [];
  }, [conversations, activePeer]);

  useEffect(() => {
    if (activePeer) {
      readRef.current[activePeer] =
        inbox.filter((m) => m.sender === activePeer).length;
    }
  }, [activePeer, inbox]);

  const handleConnect = useCallback(async () => {
    setConnecting(true);
    setError('');
    setStatus('Opening embedded wallet…');
    addLog('Opening embedded wallet (IndexedDB store)…');
    try {
      const w: EmbeddedWallet = await createWallet({
        proverEnabled: true,
        onProgress: (text) => setStatus(text),
      });
      addLog('Wallet ready');
      setStatus('Resuming your session…');
      const { address } = await createSessionAccount(w);
      setAccount(address);
      addLog(`Connected ${shortAddress(address.toString())}`);

      setStatus('Registering fee contracts…');
      await registerSponsoredFPC(w);
      addLog('SponsoredFPC registered');

      setStatus('Attaching to PrivAZy contract…');
      const c = await attachToPrivAZy(w);
      setContract(c);
      addLog(`Attached to ${shortAddress(PRIVAZY_CONTRACT_ADDRESS)}`);

      setStatus('Syncing private messages…');
      await refreshMessages(c, address);
      setStatus('Ready');
      addLog('Session ready');
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setError(`Wallet setup failed: ${msg}`);
      addLog(`Error: ${msg}`, true);
    } finally {
      setConnecting(false);
      setStatus('');
    }
  }, [refreshMessages]);

  useEffect(() => {
    if (!account || !contract) return;
    let id: number | undefined;
    const poll = () => {
      if (document.hidden) return;
      refreshMessages(contract, account);
    };
    id = window.setInterval(poll, 10000);
    const onVisible = () => {
      if (!document.hidden) refreshMessages(contract, account);
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      clearInterval(id);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [account, contract, refreshMessages]);

  const handleSend = useCallback(async () => {
    const toRaw = (activePeer ?? newPeer).trim();
    const body = draft.trim();
    if (!contract || !account || !toRaw || !body) return;
    if (!isValidAddress(toRaw)) {
      setError('Invalid address — paste a full 0x… address (64 hex chars).');
      addLog('Send blocked: invalid recipient address', true);
      return;
    }
    if (textByteLength(body) > MAX_CONTENT_BYTES) {
      setError(
        `Message too long — ${textByteLength(body)} bytes, max ${MAX_CONTENT_BYTES}.`,
      );
      addLog('Send blocked: message over byte limit', true);
      return;
    }
    setSending(true);
    setError('');
    setStatus('Proving & sending private message…');
    addLog('Building ZK proof for send…');
    try {
      const to = AztecAddress.fromStringUnsafe(toRaw);
      const result = await sendMessage(contract, account, to, body);
      const txHash = shortAddress(result.receipt.txHash.toString(), 12);
      addLog(`Confirmed on-chain ✓ ${txHash}`);
      setDraft('');
      if (!activePeer) setActivePeer(toRaw);
      setStatus('Confirmed on-chain ✓');
      setTimeout(() => refreshMessages(), 4000);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setError(`Send failed: ${msg}`);
      addLog(`Send error: ${msg}`, true);
    } finally {
      setSending(false);
      setStatus('');
    }
  }, [contract, account, activePeer, newPeer, draft, refreshMessages]);

  const copyAddress = useCallback(async () => {
    if (!account) return;
    try {
      await navigator.clipboard.writeText(account.toString());
      addLog('Address copied to clipboard');
    } catch {
      addLog('Clipboard unavailable', true);
    }
  }, [account]);

  const handleDisconnect = useCallback(() => {
    setAccount(null);
    setContract(null);
    setInbox([]);
    setOutbox([]);
    setActivePeer(null);
    setNewPeer('');
    setLog([]);
    setStatus('');
    setError('');
    setDraft('');
    readRef.current = {};
  }, []);

  const busy = connecting || sending;

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <div className="logo">P</div>
          <div>
            <h1>PrivAZy</h1>
            <div className="sub">Private messaging on Aztec</div>
          </div>
        </div>
        <div className="pills">
          <span className="pill chartreuse">ZERO-KNOWLEDGE</span>
          <span className="pill orchid">PRIVATE</span>
          <span className="pill aqua">AZTEC TESTNET</span>
          {account && (
            <button className="logout-btn" onClick={handleDisconnect}>
              Disconnect
            </button>
          )}
        </div>
      </header>

      {error && <div className="error">{error}</div>}

      {!account && !connecting && !status && (
        <section className="hero">
          <h2>
            Messages only
            <br />
            <em>you</em> can read
          </h2>
          <p className="lead">
            Every message is a zero-knowledge proof, encrypted to your keypair
            and committed on-chain. No node, sequencer, or third party can ever
            decrypt it.
          </p>
          <div className="features">
            <div className="feature">
              <span className="dot chartreuse" />
              End-to-end private
            </div>
            <div className="feature">
              <span className="dot orchid" />
              The chain is the database
            </div>
            <div className="feature">
              <span className="dot aqua" />
              Anyone can reach you
            </div>
          </div>
          <button className="btn" onClick={handleConnect} disabled={busy}>
            Create your wallet
          </button>
          <p className="hint">
            Uses an embedded Aztec wallet in your browser against the public
            testnet. Your identity and inbox are stored locally in your browser
            and survive reloads.
          </p>
        </section>
      )}

      {(connecting || status) && !account && (
        <div className="progress">
          <div className="spinner" />
          <p>{status}</p>
        </div>
      )}

      {account && (
        <main className="layout">
          <aside className="side">
            <div className="card identity">
              <div className="me">
                <div className="avatar">
                  {account.toString().slice(2, 4).toUpperCase()}
                </div>
                <div className="who">
                  <div className="label">Your address</div>
                  <code title={account.toString()}>
                    {shortAddress(account.toString(), 16)}
                  </code>
                </div>
              </div>
              <div className="actions">
                <button className="icon-btn" onClick={copyAddress}>
                  Copy
                </button>
                <button
                  className="icon-btn"
                  onClick={() => refreshMessages()}
                  disabled={refreshing}
                >
                  {refreshing ? 'Syncing…' : 'Sync'}
                </button>
              </div>
            </div>

            <div className="card convo-list">
              <div className="convo-list-head">
                <span>Conversations</span>
                <span className="convo-total">
                  {conversations.length}
                </span>
              </div>
              {conversations.length === 0 ? (
                <div className="convo-empty">
                  No conversations yet. Start one below.
                </div>
              ) : (
                conversations.map((c) => (
                  <button
                    key={c.peer}
                    className={`convo-item${activePeer === c.peer ? ' active' : ''}`}
                    onClick={() => setActivePeer(c.peer)}
                  >
                    <span className="convo-name">
                      {shortAddress(c.peer, 9)}
                      {c.last && c.last.timestamp > 0 && (
                        <span className="convo-time">
                          {formatTime(c.last.timestamp)}
                        </span>
                      )}
                      {c.unread > 0 && (
                        <span className="convo-badge">{c.unread}</span>
                      )}
                    </span>
                    <span className="convo-preview">
                      {c.last
                        ? `${c.last.dir === 'out' ? '→ ' : ''}${c.last.content || '(empty)'}`
                        : 'No messages'}
                    </span>
                  </button>
                ))
              )}
            </div>

            <details className="card log">
              <summary>Session activity</summary>
              <div className="log-inner" ref={logRef}>
                {log.map((l, i) => (
                  <div className={`log-line${l.err ? ' err' : ''}`} key={i}>
                    <span className="time">{l.time}</span>
                    {l.text}
                  </div>
                ))}
              </div>
            </details>
          </aside>

          <section className="chat-card">
            {activePeer ? (
              <div className="thread-head">
                <span className="thread-title">
                  {shortAddress(activePeer, 16)}
                </span>
                <button
                  className="icon-btn thread-new"
                  onClick={() => {
                    setActivePeer(null);
                    setNewPeer('');
                    setError('');
                  }}
                >
                  New conversation
                </button>
              </div>
            ) : (
              <div className="thread-head">
                <span className="thread-title">New conversation</span>
              </div>
            )}

            <div className="thread" ref={threadRef}>
              {activePeer && activeMessages.length === 0 ? (
                <div className="thread-empty">
                  <div className="glyph">🔒</div>
                  <p>No messages in this conversation yet</p>
                </div>
              ) : activePeer ? (
                activeMessages.map((m) => (
                  <div
                    key={m.id}
                    className={`msg${m.dir === 'out' ? ' out' : ''}`}
                  >
                    {m.dir === 'in' && (
                      <div className="sender">
                        {shortAddress(m.peer, 14)}
                      </div>
                    )}
                    <div className="body">{m.content || '(empty)'}</div>
                    {m.timestamp > 0 && (
                      <div className="time">{formatTime(m.timestamp)}</div>
                    )}
                  </div>
                ))
              ) : (
                <div className="thread-empty">
                  <div className="glyph">💬</div>
                  <p>Select a conversation</p>
                  <div className="sub">
                    Or paste an address below to start a new one.
                  </div>
                </div>
              )}
            </div>

            <div className="composer">
              {!activePeer && (
                <input
                  value={newPeer}
                  onChange={(e) => setNewPeer(e.target.value)}
                  placeholder="Start new conversation — paste Aztec address"
                  spellCheck={false}
                />
              )}
              <textarea
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                maxLength={MAX_TEXT}
                placeholder="Write a message only the recipient can read…"
              />
              <div className="row">
                <span className="counter">
                  {textByteLength(draft)} / {MAX_TEXT} bytes
                </span>
                <button
                  className="btn"
                  onClick={handleSend}
                  disabled={
                    sending ||
                    !draft.trim() ||
                    !(activePeer || newPeer.trim())
                  }
                >
                  {sending ? 'Proving & sending…' : 'Send private message'}
                </button>
              </div>
            </div>
          </section>
        </main>
      )}

      <footer className="footer">
        <div>
          Contract <code>{shortAddress(PRIVAZY_CONTRACT_ADDRESS, 14)}</code>
        </div>
        <div>Aztec testnet · embedded wallet · no servers</div>
      </footer>
    </div>
  );
}

export default App;