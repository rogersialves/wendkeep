// Interactive companion checkbox selector for `wendkeep init`.
// The state machine (initial/reduce/render/mapKey) is pure and tested; the raw-TTY
// event loop is a thin shell over it, with a text fallback when raw mode is absent.
import readline from 'node:readline';

const HINT = 'Espaço marca/desmarca · ↑/↓ move · a=todos · n=nenhum · Enter confirma';
const HEADER = 'Companions';

export function initialCompanionMenu(companions) {
  return {
    items: companions.map((c) => ({ id: c.id, label: c.label, checked: !!c.default })),
    cursor: 0,
  };
}

export function reduceCompanionMenu(state, action) {
  const n = state.items.length;
  switch (action) {
    case 'up':
      return { ...state, cursor: (state.cursor - 1 + n) % n };
    case 'down':
      return { ...state, cursor: (state.cursor + 1) % n };
    case 'space':
      return {
        ...state,
        items: state.items.map((it, i) => (i === state.cursor ? { ...it, checked: !it.checked } : it)),
      };
    case 'all':
      return { ...state, items: state.items.map((it) => ({ ...it, checked: true })) };
    case 'none':
      return { ...state, items: state.items.map((it) => ({ ...it, checked: false })) };
    case 'enter':
      return { ...state, done: true, selected: state.items.filter((it) => it.checked).map((it) => it.id) };
    default:
      return state;
  }
}

export function renderCompanionMenu(state, { hint = HINT, header = HEADER } = {}) {
  const lines = [`${header} — ${hint}:`];
  state.items.forEach((it, i) => {
    const cursor = i === state.cursor ? '>' : ' ';
    const box = it.checked ? '[x]' : '[ ]';
    lines.push(`${cursor} ${box} ${it.label}`);
  });
  return lines.join('\n');
}

export function mapKey(str, key = {}) {
  const name = key.name;
  if (name === 'up' || name === 'k') return 'up';
  if (name === 'down' || name === 'j') return 'down';
  if (name === 'space' || str === ' ') return 'space';
  if (name === 'return' || name === 'enter') return 'enter';
  if (str === 'a') return 'all';
  if (str === 'n') return 'none';
  return null;
}

// True when stdin/stdout can drive an interactive raw-mode menu.
export function canInteractiveSelect(input = process.stdin, output = process.stdout) {
  return !!(input && output && input.isTTY && output.isTTY && typeof input.setRawMode === 'function');
}

// Run the raw-TTY checkbox menu; resolves with the selected ids. Caller must check
// canInteractiveSelect() first (otherwise use the text fallback).
export function selectCompanionsInteractive(companions, { input = process.stdin, output = process.stdout, labels } = {}) {
  return new Promise((resolve) => {
    let state = initialCompanionMenu(companions);
    let drawnLines = 0;

    readline.emitKeypressEvents(input);
    input.setRawMode(true);
    input.resume();

    const draw = () => {
      if (drawnLines) {
        readline.moveCursor(output, 0, -drawnLines);
        readline.clearScreenDown(output);
      }
      const text = renderCompanionMenu(state, labels);
      output.write(`${text}\n`);
      drawnLines = text.split('\n').length;
    };

    const cleanup = () => {
      input.removeListener('keypress', onKey);
      if (typeof input.setRawMode === 'function') input.setRawMode(false);
      input.pause();
    };

    const onKey = (str, key = {}) => {
      if (key.ctrl && key.name === 'c') {
        cleanup();
        output.write('\n');
        process.exit(130);
      }
      const action = mapKey(str, key);
      if (!action) return;
      state = reduceCompanionMenu(state, action);
      if (state.done) {
        cleanup();
        resolve(state.selected);
        return;
      }
      draw();
    };

    input.on('keypress', onKey);
    draw();
  });
}
