import styles from './Brand.module.css';

// The mark is the same circuit as the topology: one line that splits into two.
export function Brand() {
  return (
    <div className={styles.brand}>
      <svg className={styles.mark} viewBox="0 0 32 32" aria-hidden="true" focusable="false">
        <path className={styles.trace} d="M4 16h9m0 0 6-7h9m-15 7h15m-15 0 6 7h9" />
        <circle className={styles.node} cx="13" cy="16" r="3" />
      </svg>
      <span className={styles.word}>MCP Gateway</span>
    </div>
  );
}
