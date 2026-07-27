// `wendkeep sync` — os três passos que se repetem iguais a cada atualização do pacote:
// init -> sync-defs -> doctor, no PROJETO CORRENTE.
//
// O `npm install` fica de fora de propósito: um processo não se auto-substitui e continua
// rodando (o código em execução seguiria sendo o antigo), e é o passo que mais varia entre
// projetos — npm, pnpm, workspace root, política de cooldown. É onde um comando "esperto"
// quebraria no repositório de outra pessoa.
//
// E opera onde é invocado, nunca sobre uma lista de projetos: o wendkeep é um pacote
// público, e um comando que varresse repositórios por nome só funcionaria numa máquina.
import { resolve } from 'node:path';

function opt(argv, name) {
  const i = argv.indexOf(name);
  if (i >= 0) return argv[i + 1];
  const eq = argv.find((a) => a.startsWith(`${name}=`));
  return eq ? eq.slice(name.length + 1) : undefined;
}

const step = (n, label) => process.stdout.write(`\n[${n}/3] ${label}\n`);

export async function runSync(argv) {
  const projectRaw = opt(argv, '--project');
  const vaultRaw = opt(argv, '--vault');
  const hasProfile = argv.includes('--profile') || argv.some((a) => a.startsWith('--profile='));
  const profileRaw = opt(argv, '--profile');
  const profileArgs = hasProfile ? ['--profile', profileRaw] : [];
  const projectPath = resolve(projectRaw && !projectRaw.startsWith('--') ? projectRaw : process.cwd());
  const passthrough = argv.filter((a) => a === '--yes' || a === '-y' || a === '--force');

  // 1. init — idempotente: refaz a fiação sem sobrescrever o que já está configurado.
  step(1, 'init');
  const { runInit } = await import('./init.mjs');
  try {
    await runInit([
      '--project', projectPath,
      ...(vaultRaw ? ['--vault', vaultRaw] : []),
      ...profileArgs,
      ...passthrough,
    ]);
  } catch (error) {
    process.stderr.write(`wendkeep sync: init falhou — ${error.message}\n`);
    return 1;
  }

  // Resolve o vault DEPOIS do init (que pode tê-lo acabado de criar) e repassa explícito.
  // Sem isso, sync-defs cairia em `--vault || OBSIDIAN_VAULT_PATH` e o env global da
  // máquina sequestraria um projeto recém-inicializado — o env bleed conhecido.
  let vaultBase;
  try {
    const { resolveProjectVault } = await import('./project-vault.mjs');
    vaultBase = resolveProjectVault({
      startDir: projectPath,
      explicitVault: vaultRaw || '',
      validateIdentity: !vaultRaw,
    }).base;
  } catch (error) {
    process.stderr.write(`wendkeep sync: vault não resolvido — ${error.message}\n`);
    return 2;
  }

  // 2. sync-defs — propaga as skills/agents da versão instalada para o projeto.
  //
  // COM --reseed, e isso é o ponto: as `wk-*` são artefato do pacote, e o sync existe para
  // rodar depois de instalar uma versão nova. Sem ressemear, o passo copia o conteúdo antigo
  // de `.brain/skills` para os destinos E carimba a versão nova no .wendkeep-meta.json — o
  // checkSyncDefs compara destino×.brain e meta×versão, os dois passam a bater, e o doctor
  // para de acusar `defs stale` sem nenhuma skill ter sido atualizada. Silenciar o aviso sem
  // resolver o problema é pior que não fazer nada.
  step(2, 'sync-defs');
  const { runSyncDefs } = await import('./sync-defs.mjs');
  const defsCode = runSyncDefs(['--vault', vaultBase, '--project', projectPath, '--reseed']);
  if (defsCode) {
    // Seguir para o doctor aqui seria enganoso: ele acusaria um `defs stale` que este
    // passo deveria ter resolvido.
    process.stderr.write('wendkeep sync: sync-defs falhou — doctor não executado.\n');
    return defsCode;
  }

  // 3. doctor — relata. Sair != 0 é o resultado esperado num vault com pendências, então o
  // código é propagado sem ser tratado como falha da cadeia.
  step(3, 'doctor');
  const { runDoctor } = await import('./doctor.mjs');
  const doctorCode = runDoctor(['--vault', vaultBase, '--project', projectPath]);

  // Nunca afirmar "tudo em dia": o doctor sai 0 mesmo tendo listado órfãos, seções
  // desatualizadas ou modelos sem preço — essas checagens não são fatais. Uma linha final
  // otimista contradiria o relatório logo acima dela.
  process.stdout.write(`\nwendkeep sync: 3 passo(s) concluído(s)${doctorCode ? ' — doctor reportou erros' : ' — veja o relatório do doctor acima'}\n`);
  return doctorCode;
}
