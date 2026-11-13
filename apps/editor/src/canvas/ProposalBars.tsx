import { useEffect, useMemo, useState } from 'react';
import {
  acceptProposal, acceptRevision, discardProposal, discardRevision, listProposals, ProposalConflictError, revisionOf,
  type ConflictChoice, type ConflictKind, type ProposalConflict, type ProposalInfo,
} from '@bogen/core';

const CONFLICT_WORDS: Record<ConflictKind, string> = {
  'changed-both': msg('changed in both'),
  'deleted-in-original': msg('deleted in the original, changed here'),
  'deleted-in-proposal': msg('removed here, changed in the original'),
  'added-under-removed': msg('added in the original under a layer this removes'),
};
import { Check, GitCompare, Square, X } from 'lucide-react';
import { showCompare } from '../panels/history-state.ts';
import type { Race, RaceLane } from '../lib/agent-api.ts';
import { useThrottledStructure } from '../doc/hooks.ts';
import { session } from '../doc/session.ts';
import { acceptLane, discardLane, laneLive, laneStatus, setKeepBranch, stopRace, useRaces } from '../panels/race-state.ts';
import { camera } from '../state/camera.ts';
import { loadUser } from '../lib/user.ts';
import { editor, useEditor } from '../state/store.ts';
import { unionRects } from './geometry.ts';
import { rectOf } from './measure.ts';
import { msg } from '../i18n/core.ts';
import { useT } from '../i18n/react.ts';

function Bar({ proposal, race, lane }: { proposal: ProposalInfo; race?: Race; lane?: RaceLane }) {
  const t = useT();
  const [conflicts, setConflicts] = useState<ProposalConflict[] | null>(null);
  const box = rectOf(proposal.id);
  if (!box) return null;
  const c = camera.value;
  const left = box.x * c.z + c.x;
  const top = box.y * c.z + c.y;
  const color = proposal.race?.color;
  const revision = revisionOf(session().doc, proposal.id);
  const draft = revision?.status === 'draft' ? revision : undefined;
  const accept = (resolve?: ConflictChoice) => {
    // A lane of a race goes through the server, which stops the other lanes first and can keep them in a branch.
    if (race && lane) return void acceptLane(race, lane);
    const s = session();
    try {
      // A revision is accepted as a whole: every artboard it redid, in one undo step.
      const selection = s.tx(() => (draft
        ? acceptRevision(s.doc, draft.id, loadUser().name || 'person', undefined, resolve).revision.targets
        : [acceptProposal(s.doc, proposal.id, undefined, resolve).sourceId]));
      setConflicts(null);
      editor().set({ selection });
      editor().showToast(s.doc.meta.get('codeProject') ? t('Accepted. Undo takes it back. Right-click it to open a pull request.') : t('Accepted. Undo takes it back.'));
    } catch (err) {
      if (err instanceof ProposalConflictError) return setConflicts(err.conflicts);
      editor().showToast((err as Error).message);
    }
  };
  const discard = () => {
    if (race && lane) return void discardLane(race, lane);
    const s = session();
    s.tx(() => (draft ? discardRevision(s.doc, draft.id, loadUser().name || 'person', undefined) : discardProposal(s.doc, proposal.id)));
  };
  const live = lane ? laneLive(lane) : false;
  // The same compare as for branches and versions: the original on one side, this copy on the other.
  const compareWithOriginal = () => {
    const { fileId } = editor();
    if (!fileId) return;
    const name = session().doc.getNode(proposal.of)?.name || proposal.name;
    void showCompare(fileId, { from: proposal.of, to: proposal.id, fromLabel: t('Original'), toLabel: lane ? lane.agent : proposal.name || t('Proposal by {by}', { by: proposal.by }), pageId: proposal.pageId ?? '', pageName: name, layers: { a: proposal.of, b: proposal.id } });
  };
  return (
    <>
      <div className="proposal-outline" data-testid="proposal-outline" style={{ left, top, width: box.w * c.z, height: box.h * c.z, ...(color ? { borderColor: color } : {}) }} />
      <div className="proposal-bar" data-ui data-testid="proposal-bar" data-proposal-id={proposal.id} data-lane={lane?.id} data-status={lane?.status} style={{ left, top: top - 34, maxWidth: Math.max(190, box.w * c.z) }} onPointerDown={(e) => e.stopPropagation()} onClick={(e) => e.stopPropagation()}>
        {color ? <span className={`lane-dot${lane?.status === 'queued' ? ' is-waiting' : ''}`} style={{ '--lane': color } as React.CSSProperties} /> : null}
        {lane ? (
          <>
            <span className="lane-name">{lane.agent}</span>
            <span className={`proposal-label${lane.status === 'failed' ? ' is-error' : ''}`} title={lane.error ?? laneStatus(lane)} data-testid="lane-status">{laneStatus(lane)}</span>
          </>
        ) : draft ? (
          <span className="proposal-label" title={draft.intent === 'alternative'
            ? (draft.checkpoint
              ? t.n(draft.targets.length, 'Alternative of {count} artboard, by {by}. The file was committed before it started.', 'Alternative of {count} artboards, by {by}. The file was committed before it started.', { by: draft.by })
              : t.n(draft.targets.length, 'Alternative of {count} artboard, by {by}', 'Alternative of {count} artboards, by {by}', { by: draft.by }))
            : (draft.checkpoint
              ? t.n(draft.targets.length, 'Revision of {count} artboard, by {by}. The file was committed before it started.', 'Revision of {count} artboards, by {by}. The file was committed before it started.', { by: draft.by })
              : t.n(draft.targets.length, 'Revision of {count} artboard, by {by}', 'Revision of {count} artboards, by {by}', { by: draft.by }))} data-testid="revision-label">
            {draft.intent === 'alternative' ? t('Alternative: {name}', { name: draft.name }) : t('Revision: {name}', { name: draft.name })} <span className="proposal-meta">{t('draft · {by}', { by: draft.by })}</span>
          </span>
        ) : <span className="proposal-label" title={proposal.note}>{proposal.note && proposal.note !== proposal.by ? t('Proposal by {by}: {note}', { by: proposal.by, note: proposal.note }) : t('Proposal by {by}', { by: proposal.by })}</span>}
        {live ? (
          <button type="button" className="btn btn-quiet proposal-discard" onClick={() => void stopRace(race!, lane)} data-testid="lane-stop"><Square size={10} /> {lane!.status === 'queued' ? t('Cancel') : t('Stop')}</button>
        ) : (
          <>
            {lane?.status === 'failed' || lane?.status === 'stopped' ? null : <button type="button" className="btn btn-primary proposal-accept" disabled={!proposal.sourceExists} title={proposal.sourceExists ? (draft ? t('Put every artboard of this revision into its original') : t('Put this into the original')) : t('The original layer is gone')} onClick={() => accept()} data-testid="proposal-accept"><Check size={12} /> {t('Accept')}</button>}
            <button type="button" className="btn btn-quiet proposal-discard" onClick={discard} data-testid="proposal-discard"><X size={12} /> {t('Discard')}</button>
            {proposal.sourceExists && !draft ? <button type="button" className="btn btn-quiet proposal-discard" onClick={compareWithOriginal} title={t('Compare with the original')} aria-label={t('Compare with the original')} data-testid="proposal-compare"><GitCompare size={12} /></button> : null}
          </>
        )}
      </div>
      {conflicts ? (
        <div className="proposal-conflicts" role="alertdialog" aria-label={t('Changed on both sides')} data-ui data-testid="proposal-conflicts" style={{ left, top: top + 4, maxWidth: Math.max(260, box.w * c.z) }} onPointerDown={(e) => e.stopPropagation()} onClick={(e) => e.stopPropagation()}>
          <p>{t.n(conflicts.length, 'One layer was changed in the original after this was made:', '{count} layers were changed in the original after this was made:')}</p>
          <ul>
            {conflicts.slice(0, 6).map((k) => (
              <li key={k.original}>
                <button type="button" className="run-link" onClick={() => editor().set({ selection: [k.copy && !k.original ? k.copy : k.original] })}>{k.name}</button>
                <span className="proposal-meta"> {t(CONFLICT_WORDS[k.kind])}</span>
              </li>
            ))}
            {conflicts.length > 6 ? <li className="proposal-meta">{t.n(conflicts.length - 6, 'and {count} more', 'and {count} more')}</li> : null}
          </ul>
          <div className="proposal-conflict-actions">
            <button type="button" className="btn btn-primary" onClick={() => accept('proposal')} data-testid="conflict-keep-proposal">{t("Use the proposal's")}</button>
            <button type="button" className="btn" onClick={() => accept('original')} data-testid="conflict-keep-original">{t('Keep my edits')}</button>
            <button type="button" className="btn btn-quiet" onClick={() => setConflicts(null)}>{t('Not now')}</button>
          </div>
        </div>
      ) : null}
    </>
  );
}

/** A race, while it runs and until the person picks: who is where, what it costs, and the decision. */
function RaceTray({ race, fit }: { race: Race; fit: () => void }) {
  const t = useT();
  const keepBranch = useRaces().keepBranch;
  const working = race.lanes.filter((l) => l.status === 'working').length;
  const waiting = race.lanes.filter((l) => l.status === 'queued').length;
  const running = working + waiting > 0;
  const lanes = race.lanes.length;
  const status = working && waiting
    ? t.n(lanes, '{working} working, {waiting} waiting · uses your plan {count} times', '{working} working, {waiting} waiting · uses your plan {count} times', { working, waiting })
    : working
      ? t.n(lanes, '{working} working · uses your plan {count} times', '{working} working · uses your plan {count} times', { working })
      : t.n(lanes, '{waiting} waiting · uses your plan {count} times', '{waiting} waiting · uses your plan {count} times', { waiting });
  return (
    <div className="proposal-tray race-tray" data-ui data-testid="race-tray" onPointerDown={(e) => e.stopPropagation()} onClick={(e) => e.stopPropagation()}>
      <strong>{running ? t('Race') : t('Race done')}</strong>
      <span className="race-dots">{race.lanes.map((l) => <span key={l.id} className={`lane-dot${l.status === 'queued' ? ' is-waiting' : ''}`} style={{ '--lane': l.color } as React.CSSProperties} title={`${l.agent}: ${laneStatus(l)}`} />)}</span>
      <span className="race-note">{running ? status : t.n(race.lanes.filter((l) => l.status === 'done').length, '{count} directions to compare', '{count} directions to compare')}</span>
      {!running ? (
        <label className="check race-keep" title={t('Before accepting, keep a branch inside this file with every copy in it')}>
          <input type="checkbox" checked={keepBranch} onChange={(e) => setKeepBranch(e.target.checked)} data-testid="race-keep-branch" />
          <span>{t('Keep the others as a branch')}</span>
        </label>
      ) : null}
      <button type="button" className="run-link" onClick={fit} data-testid="race-compare">{t('Compare')}</button>
      {running ? <button type="button" className="run-link is-danger" onClick={() => void stopRace(race)} data-testid="race-stop-all">{t('Stop all')}</button> : null}
    </div>
  );
}

/** Marks proposals on the canvas, and offers the decision right there. */
export function ProposalBars() {
  const t = useT();
  const pageId = useEditor((s) => s.pageId);
  // A scan of every layer, so not on every change: proposals come and go with layers.
  const version = useThrottledStructure();
  const { races } = useRaces();
  const [, tick] = useState(0);
  const { doc } = session();
  const proposals = useMemo(() => (pageId ? listProposals(doc, pageId) : []), [doc, pageId, version]);
  const any = proposals.length > 0;
  const live = races.some((r) => r.lanes.some(laneLive));
  useEffect(() => {
    if (!any) return;
    const off = camera.subscribe(() => tick((n) => n + 1));
    // Their boxes are measured from what the canvas painted, a frame after the change.
    const id = requestAnimationFrame(() => tick((n) => n + 1));
    // The time on a working lane moves on.
    const timer = live ? setInterval(() => tick((n) => n + 1), 1000) : undefined;
    return () => {
      off();
      cancelAnimationFrame(id);
      if (timer) clearInterval(timer);
    };
  }, [any, version, live]);
  if (!any) return null;
  const fitTo = (list: ProposalInfo[]) => {
    const ids = [...new Set(list.flatMap((p) => [p.id, ...(p.sourceExists ? [p.of] : [])]))];
    const box = unionRects(ids.flatMap((id) => rectOf(id) ?? []));
    if (box) camera.fit(box, 1);
  };
  const raceOn = races.find((r) => !r.decided && proposals.some((p) => p.race?.id === r.id));
  return (
    <>
      {proposals.map((p) => {
        const race = p.race ? races.find((r) => r.id === p.race!.id) : undefined;
        const lane = race?.lanes.find((l) => l.proposalId === p.id);
        return <Bar key={p.id} proposal={p} {...(race && lane ? { race, lane } : {})} />;
      })}
      {raceOn ? <RaceTray race={raceOn} fit={() => fitTo(proposals.filter((p) => p.race?.id === raceOn.id))} /> : (
        <div className="proposal-tray" data-ui data-testid="proposal-tray" onPointerDown={(e) => e.stopPropagation()} onClick={(e) => e.stopPropagation()}>
          <span>{t.n(proposals.length, '{count} proposal to review', '{count} proposals to review')}</span>
          <button type="button" className="run-link" onClick={() => fitTo(proposals)} data-testid="proposal-show">{t('Show')}</button>
        </div>
      )}
    </>
  );
}
