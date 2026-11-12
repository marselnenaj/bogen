import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { BogenDoc, createComponent, createInstance, createProposals, acceptProposal, proposalConflicts, ProposalConflictError, setSlot } from '../src/index.ts';

function fixture() {
 const doc = new BogenDoc(); doc.ensureFirstPage(); const page = doc.getPages()[0]!.id;
 const main = doc.insert(page, { type: 'frame', name: 'Button', style: {}, children: [{ type: 'text', name: 'Label', text: 'Before', style: {} }] });
 createComponent(doc, main);
 const label = doc.rawChildren(main)[0]!.id;
 const board = doc.insert(page, { type: 'frame', artboard: true, name: 'Screen', style: { width: '800px', height: '600px' } });
 const instance = createInstance(doc, main, board);
 return { doc, page, main, label, board, instance };
}
describe('proposals containing component instances', () => {
 it('accepts component overrides, preserves ids and comments, discards sibling directions and supports undo', () => {
  const {doc,page,main,label,board,instance} = fixture();
  const thread=doc.addThread({pageId:page,nodeId:instance,x:0,y:0,author:'Person',text:'Keep this button'});
  const [copy,sibling]=createProposals(doc,board,{by:'agent',count:2});
  const ci=doc.rawChildren(copy!)[0]!.id;
  doc.updateFields(`${ci}/${label}`,{text:'After'});
  const undo=new Y.UndoManager([doc.nodes,doc.comments],{trackedOrigins:new Set(['accept'])});
  expect(()=>acceptProposal(doc,copy!,'accept')).not.toThrow();
  expect(doc.getNode(`${instance}/${label}`)?.text).toBe('After');
  expect(doc.rawNode(instance)?.instanceOf).toBe(main);
  expect(doc.getComments().find(t=>t.id===thread)?.nodeId).toBe(instance);
  expect(doc.rawNode(copy!)).toBeUndefined();expect(doc.rawNode(sibling!)).toBeUndefined();
  expect([...doc.nodes.keys()].some(id=>id.includes('/'))).toBe(false);
  undo.undo();
  expect(doc.getNode(`${instance}/${label}`)?.text).toBe('Before');expect(doc.rawNode(copy!)).toBeDefined();expect(doc.rawNode(sibling!)).toBeDefined();
  undo.destroy();
 });
 it('keeps genuine two-sided instance conflicts until the person chooses', () => {
  const {doc,label,board,instance}=fixture();const [copy]=createProposals(doc,board,{by:'agent'});const ci=doc.rawChildren(copy!)[0]!.id;
  doc.updateFields(`${instance}/${label}`,{text:'Mine'});doc.updateFields(`${ci}/${label}`,{text:'Agent'});
  expect(proposalConflicts(doc,copy!).map(c=>c.original)).toEqual([instance]);
  expect(()=>acceptProposal(doc,copy!)).toThrow(ProposalConflictError);
  acceptProposal(doc,copy!,undefined,'original');expect(doc.getNode(`${instance}/${label}`)?.text).toBe('Mine');
 });
 it('accepts a proposal whose root is an instance',()=>{
  const {doc,label,instance}=fixture();const [copy]=createProposals(doc,instance,{by:'agent'});doc.updateFields(`${copy}/${label}`,{text:'Root'});
  acceptProposal(doc,copy!);expect(doc.getNode(`${instance}/${label}`)?.text).toBe('Root');
 });
 it('includes stored slot content when reconciling an instance',()=>{
  const {doc,main,board,instance}=fixture();
  const slot=doc.insert(main,{type:'frame',name:'Slot',slotName:'body',style:{}});
  const content=doc.insert(instance,{type:'text',name:'Body',text:'Slot text',style:{}});setSlot(doc,content,'body');
  const [copy]=createProposals(doc,board,{by:'agent'});const ci=doc.rawChildren(copy!)[0]!.id;const cc=doc.rawChildren(ci)[0]!.id;
  doc.updateFields(cc,{text:'Updated slot'});acceptProposal(doc,copy!);
  expect(doc.rawNode(content)?.text).toBe('Updated slot');expect(doc.rawNode(slot)).toBeDefined();
 });
});
