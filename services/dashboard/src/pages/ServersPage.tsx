import { useState } from 'react';
import { Link } from 'react-router';
import type { CreateServerInput, PatchServerInput, ServerTools, UpstreamServer } from '../api/client';
import { serversMessage } from '../auth/messages';
import { ServerForm } from '../servers/ServerForm';
import { useCreateServer, useDeleteServer, usePatchServer, useServerTools, useServers } from '../servers/useServers';
import { Badge } from '../ui/Badge';
import type { BadgeTone } from '../ui/Badge';
import { Brand } from '../ui/Brand';
import { Button } from '../ui/Button';
import { ThemeToggle } from '../ui/ThemeToggle';
import { Topology } from '../topology/Topology';
import type { UpstreamState } from '../topology/Topology';
import styles from './ServersPage.module.css';

// "Disabled" is not a status of the gateway: it is enabled = false, whatever the last probe said.
export function stateOf(server: UpstreamServer): UpstreamState {
  if (!server.enabled) return 'disabled';
  return server.status;
}

const STATE_LABEL: Record<UpstreamState, string> = { connected: 'Connected', unreachable: 'Unreachable', disabled: 'Disabled', unknown: 'Checking' };
const STATE_TONE: Record<UpstreamState, BadgeTone> = { connected: 'ok', unreachable: 'bad', disabled: 'muted', unknown: 'accent' };

export function ago(iso: string | null, now: number): string {
  if (iso === null) return 'never';
  const seconds = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
  if (seconds < 60) return `${seconds} s ago`;
  if (seconds < 3600) return `${Math.round(seconds / 60)} min ago`;
  if (seconds < 86_400) return `${Math.round(seconds / 3600)} h ago`;
  return `${Math.round(seconds / 86_400)} d ago`;
}

const credentialText = (server: UpstreamServer): string => {
  if (!server.credential.set) return 'none';
  return server.credential.kind === 'header' ? `header ${server.credential.header ?? ''} set` : 'bearer token set';
};

function ToolsBlock({ server, tools, now, failed }: { server: UpstreamServer; tools: ServerTools | undefined; now: number; failed: boolean }) {
  if (failed) return <p className={styles.note}>The tools could not be loaded right now.</p>;
  if (!tools) return <p className={styles.note}>Loading the tools...</p>;
  const live = server.enabled && server.status === 'connected';
  return (
    <div className={styles.tools}>
      <h3 className={styles.toolsTitle}>Tools ({tools.tools.length})</h3>
      {!live ? (
        <p className={styles.note}>
          {tools.fetchedAt === null
            ? 'Not checked yet. No tools are stored for this server.'
            : `Last known tools, stored ${ago(tools.fetchedAt, now)}. They are not offered to clients while this server is disabled or unreachable.`}
        </p>
      ) : null}
      {tools.tools.length > 0 ? (
        <ul className={styles.toolList}>
          {tools.tools.map((tool) => (
            <li key={tool.name}>
              <code>{tool.name}</code>
            </li>
          ))}
        </ul>
      ) : null}
      {tools.skipped.length > 0 ? (
        <>
          <p className={styles.note}>Not offered ({tools.skipped.length}):</p>
          <ul className={styles.toolList}>
            {tools.skipped.map((tool) => (
              <li key={tool.name}>
                <code>{tool.name}</code> <span className={styles.reason}>{tool.reason}</span>
              </li>
            ))}
          </ul>
        </>
      ) : null}
    </div>
  );
}

// The upstream servers of the gateway, for an admin. The gateway checks the admin role on every call; this screen is only
// reachable through RequireAdmin. Everything that comes from a server (names, reasons, tool names) is shown as plain text.
export function ServersPage() {
  const servers = useServers();
  const tools = useServerTools();
  const create = useCreateServer();
  const patch = usePatchServer();
  const remove = useDeleteServer();
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<string | null>(null);
  const [formFailure, setFormFailure] = useState<string | null>(null);
  // The message of the last failed toggle or removal, shown inside the row it came from.
  const [rowFailure, setRowFailure] = useState<{ serverId: string; message: string } | null>(null);

  const list = servers.data ?? [];
  const toolsById = new Map((tools.data ?? []).map((entry) => [entry.serverId, entry]));
  const now = Date.now();

  const onCreate = async (input: CreateServerInput) => {
    setFormFailure(null);
    try {
      await create.mutateAsync(input);
      setAdding(false);
    } catch (error) {
      setFormFailure(serversMessage(error, 'create'));
      throw error;
    } finally {
      // The finished mutation still holds what was sent, a credential among it: let it go now.
      create.reset();
    }
  };

  const onSave = async (id: string, change: PatchServerInput) => {
    setFormFailure(null);
    try {
      await patch.mutateAsync({ id, patch: change });
      setEditing(null);
    } catch (error) {
      setFormFailure(serversMessage(error, 'edit'));
      throw error;
    } finally {
      patch.reset();
    }
  };

  const onToggle = async (server: UpstreamServer) => {
    setRowFailure(null);
    try {
      await patch.mutateAsync({ id: server.id, patch: { enabled: !server.enabled } });
    } catch (error) {
      setRowFailure({ serverId: server.id, message: serversMessage(error, 'toggle') });
    } finally {
      patch.reset();
    }
  };

  const onDelete = async (id: string) => {
    setConfirming(null);
    setRowFailure(null);
    try {
      await remove.mutateAsync(id);
    } catch (error) {
      setRowFailure({ serverId: id, message: serversMessage(error, 'delete') });
    }
  };

  const topology = list.map((server) => ({ id: server.id, label: server.slug, state: stateOf(server) }));

  return (
    <div className={styles.page}>
      <header className={styles.header}>
        <Brand />
        <nav className={styles.nav} aria-label="Account">
          <Link to="/" className={styles.back}>
            Back
          </Link>
          <ThemeToggle />
        </nav>
      </header>
      <main id="main" className={styles.main}>
        <h1 className={styles.title}>Upstream servers</h1>
        <p className={styles.note}>The MCP servers behind the gateway. The list refreshes every 10 seconds while this tab is open.</p>

        {servers.isPending ? <p className={styles.note}>Loading the servers...</p> : null}
        {servers.isError ? (
          <div className={styles.block}>
            <p className={styles.error} role="alert">
              {serversMessage(servers.error, 'load')}
            </p>
            <Button variant="ghost" onClick={() => void servers.refetch()}>
              Try again
            </Button>
          </div>
        ) : null}

        {servers.isSuccess ? (
          <>
            <div className={styles.diagram}>
              <Topology servers={topology} />
            </div>
            <div className={styles.actions}>
              <Button
                onClick={() => {
                  setAdding(true);
                  setFormFailure(null);
                }}
                disabled={adding}
              >
                Add server
              </Button>
              <Button
                variant="ghost"
                onClick={() => {
                  void servers.refetch();
                  void tools.refetch();
                }}
                disabled={servers.isFetching}
              >
                Refresh
              </Button>
            </div>
            {servers.isRefetchError ? <p className={styles.note}>Could not refresh. The list below may be out of date.</p> : null}
            {adding ? <ServerForm onCreate={onCreate} onCancel={() => setAdding(false)} failure={formFailure} /> : null}
            {list.length === 0 ? <p className={styles.note}>No upstream servers yet.</p> : null}

            <ul className={styles.list}>
              {list.map((server) => {
                const state = stateOf(server);
                return (
                  <li key={server.id} className={styles.item}>
                    <div className={styles.head}>
                      <span className={styles.name}>{server.name}</span>
                      <code className={styles.slug}>{server.slug}</code>
                      <Badge tone={STATE_TONE[state]}>{STATE_LABEL[state]}</Badge>
                    </div>
                    <dl className={styles.meta}>
                      <dt>Address</dt>
                      <dd>{server.url}</dd>
                      <dt>Credential</dt>
                      <dd>{credentialText(server)}</dd>
                      <dt>Checked</dt>
                      <dd>{ago(server.statusCheckedAt, now)}</dd>
                      {server.enabled && server.status === 'unreachable' && server.statusReason ? (
                        <>
                          <dt>Reason</dt>
                          <dd>{server.statusReason}</dd>
                        </>
                      ) : null}
                    </dl>
                    {rowFailure && rowFailure.serverId === server.id ? (
                      <p className={styles.error} role="alert">
                        {rowFailure.message}
                      </p>
                    ) : null}
                    <ToolsBlock server={server} tools={toolsById.get(server.id)} now={now} failed={tools.isError && tools.data === undefined} />

                    {editing === server.id ? (
                      <>
                        {server.seedManaged ? <p className={styles.note}>This server was set up by the install. After a change to its name, address, timeout or credential, upgrades no longer overwrite it.</p> : null}
                        <ServerForm server={server} onSave={(change) => onSave(server.id, change)} onCancel={() => setEditing(null)} failure={formFailure} />
                      </>
                    ) : confirming === server.id ? (
                      <div className={styles.confirm} role="group" aria-label={`Remove ${server.slug}`}>
                        <p className={styles.confirmText}>
                          {server.seedManaged
                            ? `Remove "${server.name}"? It was registered by the install. Its tools disappear for everyone, its credential is deleted, and you must add it again by hand.`
                            : `Remove "${server.name}"? Its tools disappear for everyone and its credential is deleted.`}
                        </p>
                        <div className={styles.actions}>
                          <Button onClick={() => void onDelete(server.id)}>Confirm remove</Button>
                          <Button variant="ghost" onClick={() => setConfirming(null)}>
                            Cancel
                          </Button>
                        </div>
                      </div>
                    ) : (
                      <div className={styles.actions}>
                        <Button
                          variant="ghost"
                          onClick={() => {
                            setEditing(server.id);
                            setFormFailure(null);
                          }}
                          aria-label={`Edit ${server.slug}`}
                        >
                          Edit
                        </Button>
                        <Button variant="ghost" onClick={() => void onToggle(server)} disabled={patch.isPending} aria-label={`${server.enabled ? 'Disable' : 'Enable'} ${server.slug}`}>
                          {server.enabled ? 'Disable' : 'Enable'}
                        </Button>
                        <Button variant="ghost" onClick={() => setConfirming(server.id)} disabled={remove.isPending} aria-label={`Remove ${server.slug}`}>
                          Remove
                        </Button>
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
          </>
        ) : null}
      </main>
    </div>
  );
}
