import type { CommentAttachment, RunnerId } from '@bogen/core';
import { session } from '../doc/session.ts';
import { api } from '../lib/api.ts';
import { noteTarget, sendFields, type Route } from '../panels/conversation-state.ts';
import { editor } from '../state/store.ts';
import { t } from '../i18n/store.ts';

/**
 * Sends a comment that mentions an agent to the server instead of writing it into the document. That is
 * what makes it a request from a person on this device: nothing that merely arrives in a document starts
 * an agent. Throws when the server cannot be reached, so that the person keeps what they typed.
 */
export async function askAgentInComment(text: string, where: { threadId: string } | { pageId: string; nodeId?: string; x: number; y: number }, attachments?: CommentAttachment[], choice: { to?: RunnerId | 'comment'; model?: string; effort?: string } = {}): Promise<string> {
  const { fileId } = editor();
  if (!fileId) throw new Error(t('No file is open.'));
  let result;
  try {
    result = await api.postComment({ fileId, text, author: session().user.name, ...where, ...(attachments?.length ? { attachments } : {}), ...choice });
  } catch (err) {
    throw new Error(t('The comment was not sent, so no agent started: {error}', { error: (err as Error).message }));
  }
  if (result.refused) editor().showToast(result.refused);
  if (result.target) noteTarget(fileId, result.threadId, result.target);
  return result.threadId;
}

/**
 * A reply in a thread, sent where the composer said it goes. To an agent (named, chosen or followed from the
 * thread's last request) it goes through the server, which is the only way a run starts; a plain comment is
 * written into the document directly, as it always was, and starts nothing.
 */
export async function sendReply(threadId: string, text: string, files: CommentAttachment[], route: Route): Promise<void> {
  const fields = sendFields(route);
  if (!fields) {
    const s = session();
    s.doc.replyThread(threadId, s.user.name, text, undefined, files);
    return;
  }
  await askAgentInComment(text, { threadId }, files, fields);
}
