const REQ_ID_RE_SRC = '[A-Za-z0-9][A-Za-z0-9_.-]*';

export function parseTasks(md) {
  const tasks = [];
  const re = /^-\s+\[( |x)\]\s+(\S+)\s+(.*)$/gm;
  const sensorReG = /\[sensor:\s*([\w.-]+)\]/g;
  const reqReG = new RegExp(`\\[req:\\s*(${REQ_ID_RE_SRC})\\]`, 'g');
  const dependencyReG = /\[depends:\s*([\w.-]+)\]/g;
  const artifactReG = /\[artifact:\s*([\w.-]+)\]/g;
  const phaseReG = /\[phase:\s*([\w.-]+)\]/g;
  const tddReG = /\[tdd\]/gi;
  let match;
  while ((match = re.exec(String(md))) !== null) {
    let text = match[3].trim();
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
      id: match[2], text, done: match[1] === 'x',
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
