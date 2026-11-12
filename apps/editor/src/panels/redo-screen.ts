import { maybeSession } from '../doc/session.ts';
import { editor } from '../state/store.ts';

/** The selected screen, also when the person right-clicked one of its children. */
export function selectedScreen() {
  const ids=editor().selection;if(ids.length!==1)return null;
  const doc=maybeSession()?.doc;if(!doc)return null;
  return [ids[0]!,...doc.ancestors(ids[0]!)].map(id=>doc.getNode(id)).find(n=>n?.artboard)??null;
}

/** Open a scoped request. Nothing starts or creates a revision until the person sends it. */
export function redoSelectedScreen():void {
  const screen=selectedScreen(),s=editor();if(!screen||s.prompt.running)return;
  s.set({ selection:[screen.id],prompt:{...s.prompt,open:true,nodeIds:[screen.id],redo:{id:crypto.randomUUID(),nodeId:screen.id,name:screen.name}} });
}

/** Optional feedback remains the person's words; the redo always protects the original through a revision. */
export function screenRedoPrompt(feedback:string):string {
  return 'Redo only the selected screen. Improve its hierarchy, composition, typography and spacing using the effective design guidance. Preserve its factual content, functions, language and confirmed brand. Work in the server-provided revision or branch in this same file; do not create another file or page.'+(feedback.trim()?`\n\nUser feedback:\n${feedback.trim()}`:'');
}
