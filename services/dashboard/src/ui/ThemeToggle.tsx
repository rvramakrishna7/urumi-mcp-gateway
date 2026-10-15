import { useTheme } from '../theme/ThemeProvider';
import styles from './ThemeToggle.module.css';

// Shows the theme that a click switches to. The choice lives in memory and is lost on reload.
export function ThemeToggle() {
  const { theme, toggle } = useTheme();
  const next = theme === 'dark' ? 'light' : 'dark';
  return (
    <button type="button" className={styles.toggle} onClick={toggle} aria-label={`Switch to the ${next} theme`}>
      <span className={styles.label}>{next} theme</span>
    </button>
  );
}
