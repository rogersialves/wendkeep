import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, readdirSync, readlinkSync, realpathSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { spawnSync } from 'node:child_process';

const posix = (value) => String(value || '').replaceAll('\\', '/');

function git(cwd, args, { spawn = spawnSync, binary = false } = {}) {
  const result = spawn('git', args, {
    cwd,
    encoding: binary ? null : 'utf8',
    windowsHide: true,
  });
  if (result.error || result.status !== 0) {
    const detail = Buffer.isBuffer(result.stderr) ? result.stderr.toString('utf8') : result.stderr;
    const error = new Error(`git ${args.join(' ')}: ${String(detail || result.error?.message || 'falhou').trim()}`);
    error.code = 'FLOW_GIT_ERROR';
    throw error;
  }
  return result.stdout;
}

function gitOptional(cwd, args, { spawn = spawnSync } = {}) {
  const result = spawn('git', args, { cwd, encoding: 'utf8', windowsHide: true });
  if (result.error || ![0, 1].includes(result.status)) {
    const detail = Buffer.isBuffer(result.stderr) ? result.stderr.toString('utf8') : result.stderr;
    const error = new Error(`git ${args.join(' ')}: ${String(detail || result.error?.message || 'falhou').trim()}`);
    error.code = 'FLOW_GIT_ERROR';
    throw error;
  }
  return result.status === 0 ? String(result.stdout || '').trim() : '';
}

function parseGitConfigPaths(output) {
  const values = new Map();
  for (const line of String(output || '').split(/\r?\n/).filter(Boolean)) {
    const separator = line.search(/\s/);
    if (separator < 0) continue;
    values.set(line.slice(0, separator).toLowerCase(), line.slice(separator + 1).trim());
  }
  return values;
}

function fingerprintFsEntry(path, unsafePaths = [], label = '') {
  let stat;
  try {
    stat = lstatSync(path);
  } catch (error) {
    if (error?.code === 'ENOENT') return 'missing';
    throw error;
  }
  if (stat.isSymbolicLink()) {
    unsafePaths.push(label || posix(path));
    return `unsafe-link:${readlinkSync(path)}`;
  }
  if (stat.isFile()) {
    if (stat.nlink > 1) unsafePaths.push(label || posix(path));
    return `file:${stat.mode}:${stat.nlink}:${createHash('sha256').update(readFileSync(path)).digest('hex')}`;
  }
  if (stat.isDirectory()) {
    const entries = readdirSync(path).sort().map((name) => [
      name,
      fingerprintFsEntry(join(path, name), unsafePaths, label ? `${label}/${name}` : name),
    ]);
    return `dir:${createHash('sha256').update(JSON.stringify(entries)).digest('hex')}`;
  }
  return `other:${stat.mode}:${stat.size}`;
}

function resolveGitPath(root, value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  return isAbsolute(raw) ? resolve(raw) : resolve(root, raw);
}

function fingerprintGitIndirection(path, unsafePaths) {
  let stat;
  try {
    stat = lstatSync(path);
  } catch (error) {
    if (error?.code === 'ENOENT') return 'missing';
    throw error;
  }
  if (stat.isSymbolicLink()) {
    unsafePaths.push('git-indirection');
    return `unsafe-link:${readlinkSync(path)}`;
  }
  if (stat.isFile()) {
    if (stat.nlink > 1) unsafePaths.push('git-indirection');
    return `file:${stat.nlink}:${createHash('sha256').update(readFileSync(path)).digest('hex')}`;
  }
  return stat.isDirectory() ? 'directory' : `other:${stat.mode}`;
}

function gitMetadataSnapshot(root, options = {}) {
  const [gitDirValue, commonDirValue] = String(git(root, [
    'rev-parse', '--git-dir', '--git-common-dir',
  ], options)).trim().split(/\r?\n/);
  const gitDir = resolveGitPath(root, gitDirValue);
  const commonDir = resolveGitPath(root, commonDirValue);
  const configuredPaths = parseGitConfigPaths(gitOptional(root, [
    'config', '--path', '--get-regexp', '^core\\.(hooksPath|excludesFile)$',
  ], options));
  const configuredHooks = configuredPaths.get('core.hookspath') || '';
  const configuredExcludes = configuredPaths.get('core.excludesfile') || '';
  const hooksPath = configuredHooks ? resolveGitPath(root, configuredHooks) : join(commonDir, 'hooks');
  const unsafePaths = [];
  const targets = [
    ['common-config', join(commonDir, 'config')],
    ['worktree-config', join(gitDir, 'config.worktree')],
    ['info-exclude', join(commonDir, 'info', 'exclude')],
    ['hooks', hooksPath],
    ...(configuredExcludes ? [['configured-excludes', resolveGitPath(root, configuredExcludes)]] : []),
  ];
  const entries = targets.map(([label, path]) => [
    label,
    canonicalFsPath(path),
    fingerprintFsEntry(path, unsafePaths, label),
  ]);
  entries.push([
    'git-indirection',
    canonicalFsPath(join(root, '.git')),
    fingerprintGitIndirection(join(root, '.git'), unsafePaths),
  ]);
  const effectiveConfig = git(root, ['config', '--list', '--show-origin', '--show-scope', '-z'], {
    ...options,
    binary: true,
  });
  entries.push(['effective-config', createHash('sha256').update(Buffer.from(effectiveConfig)).digest('hex')]);
  return {
    fingerprint: createHash('sha256').update(JSON.stringify(entries)).digest('hex'),
    unsafePaths: [...new Set(unsafePaths)].sort(),
  };
}

function hiddenIndexPaths(root, options = {}) {
  const output = git(root, ['ls-files', '-v', '-z'], { ...options, binary: true });
  return Buffer.from(output).toString('utf8').split('\0').filter(Boolean)
    .filter((record) => {
      const tag = record[0] || '';
      return tag === 'S' || (/[a-z]/.test(tag) && tag === tag.toLowerCase());
    })
    .map((record) => posix(record.slice(2)))
    .sort();
}

function trackedGitlinks(root, options = {}) {
  const output = git(root, ['ls-files', '--stage', '-z'], { ...options, binary: true });
  return Buffer.from(output).toString('utf8').split('\0').filter(Boolean)
    .flatMap((record) => {
      const tab = record.indexOf('\t');
      if (tab < 0 || !record.startsWith('160000 ')) return [];
      return [posix(record.slice(tab + 1))];
    })
    .sort();
}

function nestedSnapshotOptions(options, relPath) {
  const prefix = posix(relPath).replace(/\/$/, '');
  const originalSpecs = Array.isArray(options.ignoredPathspecs) ? options.ignoredPathspecs : [];
  const rebased = originalSpecs.flatMap((spec) => {
    const raw = String(spec || '');
    const close = raw.startsWith(':(') ? raw.indexOf(')') : -1;
    const magic = close >= 0 ? raw.slice(0, close + 1) : '';
    const body = close >= 0 ? raw.slice(close + 1) : raw;
    const comparable = process.platform === 'win32' ? body.toLowerCase() : body;
    const comparablePrefix = process.platform === 'win32' ? prefix.toLowerCase() : prefix;
    if (!comparable.startsWith(`${comparablePrefix}/`)) return [];
    return [`${magic}${body.slice(prefix.length + 1)}`];
  });
  const parentFilter = typeof options.ignoredPathFilter === 'function' ? options.ignoredPathFilter : null;
  return {
    ...options,
    ignoredPathspecs: [...new Set([...originalSpecs, ...rebased])],
    ignoredPathFilter: parentFilter ? (path) => parentFilter(`${prefix}/${posix(path)}`) : undefined,
  };
}

function splitFixed(record, fields) {
  const out = [];
  let rest = record;
  for (let index = 0; index < fields; index += 1) {
    const at = rest.indexOf(' ');
    if (at < 0) return { fields: [...out, rest], rest: '' };
    out.push(rest.slice(0, at));
    rest = rest.slice(at + 1);
  }
  return { fields: out, rest };
}

function parseStatus(output) {
  const tokens = String(output || '').split('\0');
  const records = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const raw = tokens[index];
    if (!raw) continue;
    const kind = raw[0];
    if (kind === '1') {
      const parsed = splitFixed(raw, 8);
      records.push({ raw, paths: [parsed.rest] });
    } else if (kind === '2') {
      const parsed = splitFixed(raw, 9);
      const original = tokens[++index] || '';
      records.push({ raw: `${raw}\0${original}`, paths: [parsed.rest, original].filter(Boolean) });
    } else if (kind === 'u') {
      const parsed = splitFixed(raw, 10);
      records.push({ raw, paths: [parsed.rest] });
    } else if (kind === '?' || kind === '!') {
      records.push({ raw, paths: [raw.slice(2)] });
    }
  }
  return records;
}

function canonicalFsPath(value) {
  const path = resolve(value).replaceAll('\\', '/');
  return process.platform === 'win32' ? path.toLowerCase() : path;
}

function topologyError(message) {
  const error = new Error(message);
  error.code = 'FLOW_PATH_TOPOLOGY';
  return error;
}

function physicalScanError(message, code = 'FLOW_PHYSICAL_SCAN_ERROR') {
  const error = new Error(message);
  error.code = code;
  return error;
}

function positiveScanLimit(value, fallback, label) {
  const selected = value === undefined ? fallback : Number(value);
  if (!Number.isSafeInteger(selected) || selected < 1) {
    throw new TypeError(`${label} do scan físico deve ser inteiro positivo`);
  }
  return selected;
}

function normalizedPhysicalScanPath(value, label) {
  const normalized = posix(value).replace(/^\.\//, '').replace(/\/$/, '');
  if (!normalized || isAbsolute(normalized) || normalized.split('/').includes('..')) {
    throw new TypeError(`${label} inválido no scan físico: ${value}`);
  }
  return normalized;
}

/**
 * Walk a project tree without following symbolic links or Windows junctions. Only
 * protected candidates (and every descendant of a protected directory) are hashed;
 * the remaining tree is visited solely to discover such candidates. Exclusions are
 * checked before lstat/readdir and therefore do not consume the entry budget.
 */
export function capturePhysicalTreeSnapshot(projectRoot, options = {}) {
  const root = resolve(projectRoot);
  const rootStat = lstatSync(root);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw physicalScanError(`raiz do scan físico não é diretório local: ${root}`);
  }
  const physicalRoot = realpathSync.native(root);
  const maxDepth = positiveScanLimit(options.maxDepth, 64, 'maxDepth');
  const maxEntries = positiveScanLimit(options.maxEntries, 100_000, 'maxEntries');
  const classify = typeof options.isProtectedPath === 'function' ? options.isProtectedPath : () => false;
  const pathPrefix = String(options.pathPrefix || '').trim()
    ? normalizedPhysicalScanPath(options.pathPrefix, 'pathPrefix')
    : '';
  const normalizeCase = (value) => process.platform === 'win32' ? value.toLowerCase() : value;
  const excludedNames = new Set((options.excludedDirectoryNames || [])
    .map((value) => normalizeCase(String(value || '').trim()))
    .filter(Boolean));
  const excludedPaths = [...new Set((options.excludedPaths || [])
    .map((value) => normalizedPhysicalScanPath(value, 'excludedPath')))]
    .map(normalizeCase)
    .sort();
  const fingerprints = {};
  const unsafePaths = [];
  let entriesScanned = 0;
  let maxDepthSeen = 0;

  const excluded = (relPath, name) => {
    if (excludedNames.has(normalizeCase(name))) return true;
    const candidate = normalizeCase(relPath);
    return excludedPaths.some((path) => candidate === path || candidate.startsWith(`${path}/`));
  };
  const gitRelative = (projectRelative) => pathPrefix ? `${pathPrefix}/${projectRelative}` : projectRelative;
  const failRace = (relPath, error) => {
    throw physicalScanError(
      `scan físico protegido ficou instável em ${gitRelative(relPath)}: ${error?.message || error}`,
      'FLOW_PHYSICAL_SCAN_RACE',
    );
  };
  const record = (path, descriptor) => {
    fingerprints[path] = createHash('sha256').update(descriptor).digest('hex');
  };

  const walk = (directory, directoryRel, depth, inheritedProtected) => {
    let names;
    try {
      names = readdirSync(directory).sort();
    } catch (error) {
      failRace(directoryRel || '.', error);
    }
    for (const name of names) {
      const childRel = directoryRel ? `${directoryRel}/${name}` : name;
      if (excluded(childRel, name)) continue;
      const childDepth = depth + 1;
      if (childDepth > maxDepth) {
        throw physicalScanError(
          `scan físico protegido excedeu profundidade máxima ${maxDepth} em ${gitRelative(childRel)}`,
          'FLOW_PHYSICAL_SCAN_LIMIT',
        );
      }
      entriesScanned += 1;
      if (entriesScanned > maxEntries) {
        throw physicalScanError(
          `scan físico protegido excedeu limite de entradas ${maxEntries} em ${gitRelative(childRel)}`,
          'FLOW_PHYSICAL_SCAN_LIMIT',
        );
      }
      maxDepthSeen = Math.max(maxDepthSeen, childDepth);
      const absolute = join(directory, name);
      const protectedPath = gitRelative(childRel);
      const isProtected = inheritedProtected || Boolean(classify(protectedPath));
      let stat;
      try {
        stat = lstatSync(absolute);
      } catch (error) {
        failRace(childRel, error);
      }
      if (stat.isSymbolicLink()) {
        if (isProtected) {
          let target;
          try { target = readlinkSync(absolute); }
          catch (error) { failRace(childRel, error); }
          record(protectedPath, `link:${target}`);
          unsafePaths.push(`${protectedPath} (link simbólico/junction/reparse)`);
        }
        continue;
      }
      // lstat is authoritative for ordinary symlinks/junctions. The physical
      // identity comparison also catches Windows reparse aliases that Node may
      // expose as a directory. Resolving identity is bounded to this entry; a
      // redirected directory is never opened or traversed.
      let physical;
      try { physical = realpathSync.native(absolute); }
      catch (error) { failRace(childRel, error); }
      const expectedPhysical = join(physicalRoot, ...childRel.split('/'));
      if (canonicalFsPath(physical) !== canonicalFsPath(expectedPhysical)) {
        if (isProtected) {
          record(protectedPath, `reparse:${canonicalFsPath(physical)}`);
          unsafePaths.push(`${protectedPath} (junction/reparse redirecionado)`);
        }
        continue;
      }
      if (stat.isFile()) {
        if (isProtected) {
          let content;
          try { content = readFileSync(absolute); }
          catch (error) { failRace(childRel, error); }
          record(protectedPath, `file:${stat.mode}:${stat.size}:${stat.nlink}:${createHash('sha256').update(content).digest('hex')}`);
          if (stat.nlink > 1) unsafePaths.push(`${protectedPath} (hardlink nlink=${stat.nlink})`);
        }
        continue;
      }
      if (stat.isDirectory()) {
        if (isProtected) record(protectedPath, `dir:${stat.mode}`);
        walk(absolute, childRel, childDepth, isProtected);
        continue;
      }
      if (isProtected) {
        record(protectedPath, `other:${stat.mode}:${stat.size}`);
        unsafePaths.push(`${protectedPath} (tipo físico especial)`);
      }
    }
  };

  walk(root, '', 0, false);
  const orderedFingerprints = Object.fromEntries(Object.entries(fingerprints)
    .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0));
  return {
    schema_version: 1,
    fingerprint: createHash('sha256').update(JSON.stringify(orderedFingerprints)).digest('hex'),
    fingerprints: orderedFingerprints,
    unsafe_paths: [...new Set(unsafePaths)].sort(),
    entries_scanned: entriesScanned,
    max_depth_seen: maxDepthSeen,
  };
}

function assertRelativePathTopology(root, relPath) {
  const normalized = posix(relPath).replace(/\/\*\*$/, '');
  if (!normalized || isAbsolute(normalized)) {
    throw topologyError(`path FLOW inválido para inspeção física: ${relPath}`);
  }
  const absolute = resolve(root, ...normalized.split('/'));
  const fromRoot = relative(root, absolute);
  if (fromRoot === '..' || fromRoot.startsWith(`..${sep}`) || isAbsolute(fromRoot)) {
    throw topologyError(`path FLOW sai da raiz física: ${relPath}`);
  }

  let cursor = root;
  const segments = normalized.split('/').filter(Boolean);
  for (let index = 0; index < segments.length; index += 1) {
    cursor = join(cursor, segments[index]);
    let stat;
    try {
      stat = lstatSync(cursor);
    } catch (error) {
      if (error?.code === 'ENOENT') break;
      throw error;
    }
    if (stat.isSymbolicLink()) {
      throw topologyError(`path FLOW atravessa link simbólico/reparse: ${relPath}`);
    }
    const physical = realpathSync.native(cursor);
    const physicalFromRoot = relative(root, physical);
    const escaped = physicalFromRoot === '..'
      || physicalFromRoot.startsWith(`..${sep}`)
      || isAbsolute(physicalFromRoot);
    const redirected = process.platform === 'win32'
      && canonicalFsPath(physical) !== canonicalFsPath(cursor);
    if (escaped || redirected) {
      throw topologyError(`path FLOW sai da raiz física por reparse: ${relPath}`);
    }
    if (index === segments.length - 1 && stat.isFile() && stat.nlink > 1) {
      throw topologyError(`path FLOW alterado possui hardlink: ${relPath}`);
    }
  }
}

function assertAllowedTreeTopology(root, allowed) {
  if (!posix(allowed).endsWith('/**')) return;
  const baseRel = posix(allowed).slice(0, -3);
  const base = join(root, ...baseRel.split('/'));
  let baseStat;
  try {
    baseStat = lstatSync(base);
  } catch (error) {
    if (error?.code === 'ENOENT') return;
    throw error;
  }
  if (!baseStat.isDirectory()) return;
  const pending = [baseRel];
  while (pending.length) {
    const parentRel = pending.pop();
    const parent = join(root, ...parentRel.split('/'));
    for (const name of readdirSync(parent).sort()) {
      const childRel = `${parentRel}/${name}`;
      assertRelativePathTopology(root, childRel);
      const child = join(root, ...childRel.split('/'));
      const stat = lstatSync(child);
      if (stat.isDirectory()) pending.push(childRel);
    }
  }
}

function worktreeFingerprint(root, relPath, options = {}, diagnostics = {
  unsafeWorktree: [], hiddenIndex: [], nestedMetadata: [], nestedFingerprints: {},
}) {
  const path = join(root, ...posix(relPath).split('/'));
  try {
    lstatSync(path);
  } catch (error) {
    if (error?.code === 'ENOENT') return 'missing';
    throw error;
  }
  try {
    assertRelativePathTopology(root, relPath);
  } catch (error) {
    diagnostics.unsafeWorktree.push(posix(relPath));
    return `unsafe:${error.code}:${createHash('sha256').update(error.message).digest('hex')}`;
  }
  const stat = lstatSync(path);
  if (stat.isSymbolicLink()) {
    diagnostics.unsafeWorktree.push(posix(relPath));
    return `symlink:${readlinkSync(path)}`;
  }
  let gitMarker = null;
  if (stat.isDirectory()) {
    try {
      gitMarker = lstatSync(join(path, '.git'));
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
    if (gitMarker?.isSymbolicLink()) {
      diagnostics.unsafeWorktree.push(`${posix(relPath)}/.git`);
      return `unsafe-gitlink-marker:${readlinkSync(join(path, '.git'))}`;
    }
    if (gitMarker && !gitMarker.isFile() && !gitMarker.isDirectory()) {
      diagnostics.unsafeWorktree.push(`${posix(relPath)}/.git`);
      return `unsafe-gitlink-marker:${gitMarker.mode}`;
    }
  }
  if (stat.isDirectory() && gitMarker) {
    const childRoot = realpathSync.native(path);
    const nested = captureGitSnapshot(path, {
      ...nestedSnapshotOptions(options, relPath),
      _gitlinkDepth: Number(options._gitlinkDepth || 0) + 1,
      _expectedGitlinkRoot: childRoot,
    });
    for (const unsafe of nested.unsafe_worktree_paths || []) {
      diagnostics.unsafeWorktree.push(`${posix(relPath)}/${unsafe}`);
    }
    for (const unsafe of nested.unsafe_git_metadata_paths || []) {
      diagnostics.unsafeWorktree.push(`${posix(relPath)}/.git:${unsafe}`);
    }
    for (const hidden of nested.hidden_index_paths || []) {
      diagnostics.hiddenIndex.push(`${posix(relPath)}/${hidden}`);
    }
    for (const [nestedPath, fingerprint] of Object.entries(nested.fingerprints || {})) {
      diagnostics.nestedFingerprints[`${posix(relPath)}/${nestedPath}`] = fingerprint;
    }
    diagnostics.nestedMetadata.push([
      posix(relPath),
      nested.git_metadata_fingerprint,
      nested.hidden_index_paths || [],
    ]);
    return `gitlink:${createHash('sha256').update(JSON.stringify(nested)).digest('hex')}`;
  }
  if (!stat.isFile()) return `other:${stat.mode}`;
  const hash = createHash('sha256').update(readFileSync(path)).digest('hex');
  return `file:${stat.mode}:${hash}`;
}

export function captureGitSnapshot(projectRoot, options = {}) {
  const start = resolve(projectRoot);
  const [rootValue, headValue] = String(git(start, [
    'rev-parse', '--show-toplevel', '--verify', 'HEAD',
  ], options)).trim().split(/\r?\n/);
  const root = realpathSync.native(resolve(rootValue));
  const canonicalRoot = canonicalFsPath(root);
  const expectedRoot = options._expectedGitlinkRoot ? canonicalFsPath(options._expectedGitlinkRoot) : '';
  if (expectedRoot && canonicalRoot !== expectedRoot) {
    const error = new Error(`gitlink redireciona para outro worktree: ${root}`);
    error.code = 'FLOW_GITLINK_TOPOLOGY';
    throw error;
  }
  const depth = Number(options._gitlinkDepth || 0);
  const seen = new Set(Array.isArray(options._gitlinkSeen) ? options._gitlinkSeen : []);
  if (!Number.isSafeInteger(depth) || depth < 0 || depth > 8 || seen.has(canonicalRoot) || seen.size >= 64) {
    const error = new Error(`topologia de gitlinks cíclica ou excessiva: ${root}`);
    error.code = 'FLOW_GITLINK_TOPOLOGY';
    throw error;
  }
  seen.add(canonicalRoot);
  options = { ...options, _gitlinkDepth: depth, _gitlinkSeen: [...seen] };
  const head = String(headValue || '').trim();
  const status = git(root, ['status', '--porcelain=v2', '-z', '--untracked-files=all'], { ...options, binary: true });
  const fingerprints = {};
  const dirtyPaths = new Set();
  const diagnostics = {
    unsafeWorktree: [], hiddenIndex: [], nestedMetadata: [], nestedFingerprints: {},
  };
  for (const record of parseStatus(Buffer.from(status).toString('utf8'))) {
    const paths = record.paths.map(posix);
    for (const path of paths) dirtyPaths.add(path);
    const worktree = paths.map((path) => [path, worktreeFingerprint(root, path, options, diagnostics)]);
    const fingerprint = createHash('sha256')
      .update(JSON.stringify({ raw: record.raw, worktree }))
      .digest('hex');
    for (const path of paths) fingerprints[path] = fingerprint;
  }
  // A clean gitlink is absent from `git status`; enumerate the index so metadata-only
  // drift inside every nested repository remains visible throughout the FLOW.
  for (const path of trackedGitlinks(root, options)) {
    if (Object.hasOwn(fingerprints, path)) continue;
    fingerprints[path] = createHash('sha256')
      .update(`gitlink-index:${worktreeFingerprint(root, path, options, diagnostics)}`)
      .digest('hex');
  }
  Object.assign(fingerprints, diagnostics.nestedFingerprints);
  const ignoredPathspecs = Array.isArray(options.ignoredPathspecs) ? options.ignoredPathspecs : [];
  if (ignoredPathspecs.length) {
    const ignored = git(root, [
      'ls-files', '--others', '--ignored', '--exclude-standard', '-z', '--', ...ignoredPathspecs,
    ], { ...options, binary: true });
    for (const rawPath of Buffer.from(ignored).toString('utf8').split('\0').filter(Boolean)) {
      const path = posix(rawPath);
      if (typeof options.ignoredPathFilter === 'function' && !options.ignoredPathFilter(path)) continue;
      dirtyPaths.add(path);
      const fingerprint = createHash('sha256')
        .update(`ignored:${worktreeFingerprint(root, path, options, diagnostics)}`)
        .digest('hex');
      fingerprints[path] = fingerprint;
    }
  }
  const metadata = gitMetadataSnapshot(root, options);
  const ownHiddenIndex = hiddenIndexPaths(root, options);
  return {
    schema_version: 1,
    root,
    head,
    fingerprints,
    dirty_paths: [...dirtyPaths].sort(),
    git_metadata_fingerprint: createHash('sha256').update(JSON.stringify([
      metadata.fingerprint,
      diagnostics.nestedMetadata.sort(([left], [right]) => left.localeCompare(right)),
    ])).digest('hex'),
    unsafe_git_metadata_paths: metadata.unsafePaths,
    hidden_index_paths: [...new Set([...ownHiddenIndex, ...diagnostics.hiddenIndex])].sort(),
    unsafe_worktree_paths: [...new Set(diagnostics.unsafeWorktree)].sort(),
  };
}

export function diffGitSnapshots(before, after) {
  const paths = new Set([
    ...Object.keys(before?.fingerprints || {}),
    ...Object.keys(after?.fingerprints || {}),
    ...Object.keys(before?.protected_physical_fingerprints || {}),
    ...Object.keys(after?.protected_physical_fingerprints || {}),
  ]);
  const changedPaths = [...paths]
    .filter((path) => before?.fingerprints?.[path] !== after?.fingerprints?.[path]
      || before?.protected_physical_fingerprints?.[path]
        !== after?.protected_physical_fingerprints?.[path])
    .sort();
  const beforeRoot = resolve(String(before?.root || ''));
  const afterRoot = resolve(String(after?.root || ''));
  const rootChanged = process.platform === 'win32'
    ? beforeRoot.toLowerCase() !== afterRoot.toLowerCase()
    : beforeRoot !== afterRoot;
  return {
    rootChanged,
    headChanged: before?.head !== after?.head,
    metadataChanged: before?.git_metadata_fingerprint !== after?.git_metadata_fingerprint
      || JSON.stringify(before?.hidden_index_paths || []) !== JSON.stringify(after?.hidden_index_paths || []),
    changedPaths,
  };
}

export function normalizeAllowedPaths(projectRoot, gitRoot, paths) {
  // Git may expand an 8.3 Windows path while Node keeps the short spelling from
  // %TEMP%. Canonicalize both roots before comparing them so the same directory
  // is not mistaken for an escape from the repository.
  const project = realpathSync.native(resolve(projectRoot));
  const root = realpathSync.native(resolve(gitRoot));
  const normalized = (paths || []).map((raw) => {
    const value = String(raw || '').trim();
    if (!value) throw new TypeError('path permitido vazio');
    if (isAbsolute(value)) throw new TypeError(`path permitido deve ser relativo: ${value}`);
    const prefix = /(?:[\\/]\*\*|[\\/])$/.test(value);
    const withoutGlob = value.replace(/[\\/]\*\*$/, '').replace(/[\\/]$/, '');
    const absolute = resolve(project, withoutGlob);
    const fromProject = relative(project, absolute);
    if (fromProject === '..' || fromProject.startsWith(`..${sep}`) || isAbsolute(fromProject)) {
      throw new TypeError(`path fora do projeto: ${value}`);
    }
    const fromGit = relative(root, absolute);
    if (!fromGit || fromGit === '..' || fromGit.startsWith(`..${sep}`) || isAbsolute(fromGit)) {
      throw new TypeError(`path fora do repositório Git: ${value}`);
    }
    const gitRelative = posix(fromGit);
    if (gitRelative.split('/').some((segment) => segment.toLowerCase() === '.git')) {
      throw new TypeError(`metadados Git não são permitidos no FLOW: ${value}`);
    }
    return `${gitRelative}${prefix ? '/**' : ''}`;
  });
  return [...new Set(normalized)].sort();
}

export function assertAllowedPathTopology(gitRoot, allowedPaths, changedPaths = []) {
  const root = realpathSync.native(resolve(gitRoot));
  for (const allowed of allowedPaths || []) {
    const relPath = posix(allowed).replace(/\/\*\*$/, '');
    try {
      assertRelativePathTopology(root, relPath);
    } catch (error) {
      if (error?.code !== 'FLOW_PATH_TOPOLOGY') throw error;
      throw topologyError(error.message.replace('path FLOW', 'path permitido'));
    }
    assertAllowedTreeTopology(root, allowed);
  }
  for (const changed of changedPaths || []) {
    assertRelativePathTopology(root, changed);
  }
  return true;
}

export function assertPathRootTopology(gitRoot, paths) {
  const root = realpathSync.native(resolve(gitRoot));
  for (const path of paths || []) assertRelativePathTopology(root, path);
  return true;
}

export function pathAllowed(path, allowlist) {
  const candidate = process.platform === 'win32' ? posix(path).toLowerCase() : posix(path);
  return (allowlist || []).some((allowed) => {
    const normalized = process.platform === 'win32' ? posix(allowed).toLowerCase() : posix(allowed);
    if (normalized.endsWith('/**')) {
      const prefix = normalized.slice(0, -3);
      return candidate === prefix || candidate.startsWith(`${prefix}/`);
    }
    return candidate === normalized;
  });
}

export function runGitDiffCheck(gitRoot, { spawn = spawnSync, paths = [] } = {}) {
  const cwd = resolve(gitRoot);
  const selected = paths || [];
  const result = spawn('git', ['diff', '--check', 'HEAD', '--', ...selected], {
    cwd, encoding: 'utf8', windowsHide: true,
  });
  const baseOutput = `${result.stdout || ''}${result.stderr || ''}`.trim();
  if (result.error || result.status !== 0) {
    return { ok: false, status: result.status ?? 1, output: baseOutput };
  }
  const outputs = [];

  let candidates = selected;
  if (!candidates.length) {
    const untracked = spawn('git', ['ls-files', '--others', '--exclude-standard', '-z'], {
      cwd, encoding: 'utf8', windowsHide: true,
    });
    if (untracked.error || untracked.status !== 0) {
      const output = `${untracked.stdout || ''}${untracked.stderr || ''}`.trim();
      return { ok: false, status: untracked.status ?? 1, output };
    }
    candidates = String(untracked.stdout || '').split('\0').filter(Boolean);
  }

  for (const path of candidates) {
    const tracked = spawn('git', ['ls-files', '--error-unmatch', '--', path], {
      cwd, encoding: 'utf8', windowsHide: true,
    });
    if (!tracked.error && tracked.status === 0) continue;
    const check = spawn('git', ['diff', '--no-index', '--check', '--', '/dev/null', path], {
      cwd, encoding: 'utf8', windowsHide: true,
    });
    const output = `${check.stdout || ''}${check.stderr || ''}`.trim();
    const diagnostics = output.split(/\r?\n/)
      .filter((line) => line && !/^warning: .*\b(?:LF|CRLF) will be replaced by (?:LF|CRLF)\b/i.test(line))
      .join('\n');
    // --no-index returns 1 for an ordinary difference. Only diagnostics/output,
    // execution errors, or status >1 represent a failed whitespace check.
    if (diagnostics) outputs.push(diagnostics);
    if (check.error || ![0, 1].includes(check.status)) {
      return { ok: false, status: check.status ?? 1, output: outputs.join('\n') };
    }
  }
  return { ok: outputs.length === 0, status: outputs.length ? 1 : 0, output: outputs.join('\n') };
}
