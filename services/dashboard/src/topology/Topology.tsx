import styles from './Topology.module.css';

export type UpstreamState = 'connected' | 'unreachable' | 'disabled';

export interface TopologyServer {
  id: string;
  label: string;
  state: UpstreamState;
}

interface TopologyProps {
  servers: readonly TopologyServer[];
  // True when the drawing carries no real data (the login screen): it is hidden from assistive technology.
  decorative?: boolean;
}

const STATE_TEXT: Record<UpstreamState, string> = {
  connected: 'connected',
  unreachable: 'unreachable',
  disabled: 'disabled',
};

const WIDTH = 640;
const ROW = 84;
const GATEWAY_RIGHT = 356;
const BRANCH_X = 388;
const SERVER_X = 500;

// client -> gateway -> one line per upstream server. The geometry is plain numbers: the look (colour, dash, motion) is all
// in the CSS, driven by the state class of each server, and the state is also written as text in its node.
export function Topology({ servers, decorative = false }: TopologyProps) {
  const height = Math.max(320, (servers.length - 1) * ROW + 120);
  const mid = height / 2;
  const summary = servers.map((server) => `${server.label} ${STATE_TEXT[server.state]}`).join(', ');
  return (
    <svg
      className={styles.svg}
      viewBox={`0 0 ${WIDTH} ${height}`}
      focusable="false"
      {...(decorative ? { 'aria-hidden': true } : { role: 'img', 'aria-label': `Topology: client, gateway, ${summary || 'no upstream servers'}` })}
    >
      <g className={styles.link}>
        <path className={styles.line} d={`M120 ${mid}H236`} />
        <path className={styles.packet} d={`M120 ${mid}H236`} />
      </g>

      <g className={styles.endpoint}>
        <rect className={styles.box} x="16" y={mid - 30} width="104" height="60" rx="10" />
        <text className={styles.label} x="68" y={mid + 4} textAnchor="middle">
          client
        </text>
      </g>

      <g className={styles.gateway}>
        <rect className={styles.ring} x="230" y={mid - 44} width="132" height="88" rx="16" />
        <rect className={styles.box} x="236" y={mid - 38} width="120" height="76" rx="10" />
        <text className={styles.label} x="296" y={mid + 4} textAnchor="middle">
          gateway
        </text>
      </g>

      <g className={styles.upstreams}>
        {servers.map((server, index) => {
          const y = mid + (index - (servers.length - 1) / 2) * ROW;
          const dy = Math.abs(y - mid);
          const path =
            dy === 0 ? `M${GATEWAY_RIGHT} ${mid}H${SERVER_X}` : `M${GATEWAY_RIGHT} ${mid}H${BRANCH_X}L${BRANCH_X + dy} ${y}H${SERVER_X}`;
          return (
            <g key={server.id} className={`${styles.upstream} ${styles[server.state]}`}>
              <path className={styles.line} d={path} />
              <path className={styles.packet} d={path} />
              <rect className={styles.box} x={SERVER_X} y={y - 28} width="124" height="56" rx="10" />
              <text className={styles.label} x={SERVER_X + 62} y={y - 3} textAnchor="middle">
                {server.label}
              </text>
              <text className={styles.state} x={SERVER_X + 62} y={y + 15} textAnchor="middle">
                {STATE_TEXT[server.state]}
              </text>
            </g>
          );
        })}
      </g>
    </svg>
  );
}
