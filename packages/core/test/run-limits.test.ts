import { describe, expect, it } from 'vitest';
import { BogenDoc, createProposals, listProposals, LANE_COLORS, MAX_DIRECTION_LANES, MAX_PARALLEL_RUNS } from '../src/index.ts';

describe('explicit many-agent directions', () => {
  it('creates sixteen independent proposal copies while keeping the original untouched', () => {
    const doc=new BogenDoc();doc.ensureFirstPage();const page=doc.getPages()[0]!.id;
    const frame=doc.insert(page,{type:'frame',name:'Card',artboard:true,style:{width:'320px',height:'200px'}});
    const child=doc.insert(frame,{type:'text',name:'Title',text:'Original'});
    const ids=createProposals(doc,frame,{by:'person',count:MAX_DIRECTION_LANES});
    expect(ids).toHaveLength(16);expect(new Set(ids).size).toBe(16);expect(listProposals(doc)).toHaveLength(16);
    expect(doc.getNode(child)?.text).toBe('Original');expect(doc.getChildren(frame)).toHaveLength(1);
    expect(MAX_PARALLEL_RUNS).toBe(16);expect(new Set(LANE_COLORS).size).toBe(16);
    doc.y.destroy();
  });
  it('rejects seventeen and fractional counts before making any copies', () => {
    const doc=new BogenDoc();doc.ensureFirstPage();const page=doc.getPages()[0]!.id;
    const frame=doc.insert(page,{type:'frame',name:'Card'});
    for(const count of [17,2.5,NaN,0])expect(()=>createProposals(doc,frame,{by:'person',count})).toThrow();
    expect(listProposals(doc)).toHaveLength(0);doc.y.destroy();
  });
});
