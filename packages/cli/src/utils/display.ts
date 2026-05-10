/**
 * CLI display utilities — colors, formatting, spinners.
 */

// ANSI color codes
const colors = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  cyan: '\x1b[36m',
  gray: '\x1b[90m',
} as const;

export function bold(s: string) { return `${colors.bold}${s}${colors.reset}`; }
export function red(s: string) { return `${colors.red}${s}${colors.reset}`; }
export function green(s: string) { return `${colors.green}${s}${colors.reset}`; }
export function yellow(s: string) { return `${colors.yellow}${s}${colors.reset}`; }
export function blue(s: string) { return `${colors.blue}${s}${colors.reset}`; }
export function cyan(s: string) { return `${colors.cyan}${s}${colors.reset}`; }
export function gray(s: string) { return `${colors.gray}${s}${colors.reset}`; }
export function magenta(s: string) { return `${colors.magenta}${s}${colors.reset}`; }

export function success(msg: string) { console.log(`  ${green('✅')} ${msg}`); }
export function error(msg: string) { console.log(`  ${red('❌')} ${msg}`); }
export function warn(msg: string) { console.log(`  ${yellow('⚠️')} ${msg}`); }
export function info(msg: string) { console.log(`  ${blue('ℹ')} ${msg}`); }

export function header(title: string) {
  console.log(`\n${bold(title)}`);
  console.log(gray('═'.repeat(Math.min(title.length + 10, 60))));
}

export function diagnosticLine(level: 'error' | 'warn' | 'suggestion', line: number | undefined, msg: string, suggestion?: string) {
  const prefix = level === 'error' ? red('❌') : level === 'warn' ? yellow('⚠️') : blue('💡');
  const lineStr = line !== undefined ? gray(`line ${line}: `) : '';
  console.log(`  ${prefix} ${lineStr}${msg}`);
  if (suggestion) {
    console.log(`     ${gray('→')} ${suggestion}`);
  }
}

export function table(rows: string[][]) {
  if (rows.length === 0) return;
  const colWidths = rows[0].map((_, i) =>
    Math.max(...rows.map(r => (r[i] || '').length))
  );
  for (const row of rows) {
    const formatted = row.map((cell, i) => cell.padEnd(colWidths[i])).join('  ');
    console.log(`  ${formatted}`);
  }
}

const spinnerFrames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

export function createSpinner(msg: string) {
  let i = 0;
  let running = true;
  const interval = setInterval(() => {
    if (!running) return;
    process.stdout.write(`\r  ${cyan(spinnerFrames[i % spinnerFrames.length])} ${msg}`);
    i++;
  }, 80);

  return {
    stop(finalMsg?: string) {
      running = false;
      clearInterval(interval);
      process.stdout.write('\r' + ' '.repeat(msg.length + 10) + '\r');
      if (finalMsg) console.log(`  ${finalMsg}`);
    }
  };
}
