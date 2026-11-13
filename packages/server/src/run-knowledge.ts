import { readProject, type BogenDoc } from '@bogen/core';
import type { RunRequest } from './agents.ts';
import type { BogenServer } from './http/server.ts';
import { DISCIPLINE_IDS, inferDiscipline } from './design-knowledge/index.ts';

/** Read cheap scope metadata, never the whole canvas, to choose one relevant skill. */
export function runDiscipline(req: RunRequest, doc: BogenDoc, isBrand = false): string {
  // A skill the person chose with / in the chat comes before anything read from the words.
  if (req.discipline && DISCIPLINE_IDS.includes(req.discipline)) return req.discipline;
  const asked = inferDiscipline(req.title || req.prompt);
  if (asked !== 'foundations') return asked;
  const profiles = new Set<string>();
  for (const id of req.nodeIds ?? []) {
    for (const key of [id, ...doc.ancestors(id)]) {
      const profile = doc.getNode(key)?.attrs?.['data-bogen-discipline'];
      if (profile && DISCIPLINE_IDS.includes(profile)) { profiles.add(profile); break; }
    }
  }
  if (profiles.size === 1) return [...profiles][0]!;
  if (profiles.size > 1) return 'foundations';
  const project = readProject(doc, isBrand);
  if (project.type === 'website') return 'websites';
  if (project.type.endsWith('-theme')) return 'themes';
  if (project.type === 'omasidebar-widget') return 'widgets';
  if (project.type === 'brand') return 'brand';
  if (project.type === 'app') {
    const mobile = project.platforms?.some(p => p === 'ios' || p === 'android');
    if (mobile && project.platforms?.includes('desktop')) return 'foundations';
    return mobile ? 'mobile-apps' : 'desktop-apps';
  }
  return 'foundations';
}

/** Every built-in canvas run receives the current effective skill, including personal overrides, before spawning. */
export async function prepareRunKnowledge(app: BogenServer, req: RunRequest): Promise<RunRequest> {
  if (req.live) return req;
  const { doc } = await app.rooms.get(req.fileId);
  const skill = app.knowledge.skill(runDiscipline(req, doc, app.storage.get(req.fileId)?.kind === 'brand'));
  if (skill.markdown.length > 64_000) throw new Error('The personal design skill exceeds 64000 characters. Shorten it or restore the original before starting an agent.');
  return { ...req, project: readProject(doc, app.storage.get(req.fileId)?.kind === 'brand'), designGuidance: { discipline:skill.discipline, revision:skill.revision, customized:skill.customized, markdown:skill.markdown } };
}
