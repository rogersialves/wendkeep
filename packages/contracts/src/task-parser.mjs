const REQ_ID_RE_SRC = '[A-Za-z0-9][A-Za-z0-9_.-]*';

function isInlineWhitespace(value) {
  return value !== undefined && value !== '\r' && value !== '\n' && value.trim() === '';
}

function parseTaskLine(line) {
  let cursor = 0;
  if (line[cursor] !== '-') return null;
  cursor += 1;

  const beforeCheckbox = cursor;
  while (isInlineWhitespace(line[cursor])) cursor += 1;
  if (cursor === beforeCheckbox || line[cursor] !== '[') return null;
  cursor += 1;

  const marker = line[cursor];
  if (marker !== ' ' && marker !== 'x') return null;
  cursor += 1;
  if (line[cursor] !== ']') return null;
  cursor += 1;

  const beforeId = cursor;
  while (isInlineWhitespace(line[cursor])) cursor += 1;
  if (cursor === beforeId) return null;

  const idStart = cursor;
  while (cursor < line.length && !isInlineWhitespace(line[cursor])) cursor += 1;
  if (cursor === idStart) return null;
  const id = line.slice(idStart, cursor);

  const beforeText = cursor;
  while (isInlineWhitespace(line[cursor])) cursor += 1;
  if (cursor === beforeText) return null;

  return { done: marker === 'x', id, text: line.slice(cursor).trim() };
}

export function parseTasks(md) {
  const tasks = [];
  const sensorReG = /\[sensor:\s*([\w.-]+)\]/g;
  const reqReG = new RegExp(`\\[req:\\s*(${REQ_ID_RE_SRC})\\]`, 'g');
  const dependencyReG = /\[depends:\s*([\w.-]+)\]/g;
  const artifactReG = /\[artifact:\s*([\w.-]+)\]/g;
  const phaseReG = /\[phase:\s*([\w.-]+)\]/g;
  const tddReG = /\[tdd\]/gi;
  for (const rawLine of String(md).split('\n')) {
    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
    const parsed = parseTaskLine(line);
    if (!parsed) continue;
    let { text } = parsed;
    const sensors = [...new Set([...text.matchAll(sensorReG)].map((entry) => entry[1]))];
    const reqs = [...text.matchAll(reqReG)].map((entry) => entry[1]);
    const dependencies = [...new Set([...text.matchAll(dependencyReG)].map((entry) => entry[1]))];
    const artifacts = [...new Set([...text.matchAll(artifactReG)].map((entry) => entry[1]))];
    const phases = [...new Set([...text.matchAll(phaseReG)].map((entry) => entry[1]))];
    const tdd = tddReG.test(text);
    tddReG.lastIndex = 0;
    const sensor = sensors[0];
    if (sensors.length) text = text.replace(sensorReG, '');
    if (reqs.length) text = text.replace(reqReG, '');
    if (dependencies.length) text = text.replace(dependencyReG, '');
    if (artifacts.length) text = text.replace(artifactReG, '');
    if (phases.length) text = text.replace(phaseReG, '');
    if (tdd) text = text.replace(tddReG, '');
    text = text.replace(/\s+/g, ' ').trim();
    tasks.push({
      id: parsed.id, text, done: parsed.done,
      ...(sensor ? { sensor, sensors } : {}),
      ...(reqs.length ? { req: reqs[0], reqs } : {}),
      ...(dependencies.length ? { dependencies } : {}),
      ...(artifacts.length ? { artifacts } : {}),
      ...(phases.length ? { phase: phases[0] } : {}),
      ...(tdd ? { tdd: true } : {}),
    });
  }
  return tasks;
}
