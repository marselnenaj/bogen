import { expect, it } from 'vitest';
import { branchTree } from '../src/lib/version-tree.ts';
import type { DesignBranchRow } from '../src/lib/design-branches-api.ts';
const row=(id:string,parent:string|null)=>({id,parent,name:id,status:'open',current:id==='main',changed:false,by:'user',at:null})as DesignBranchRow;
it('shows true branch ancestry independent of API ordering',()=>{
 expect(branchTree([row('child','proposal'),row('main',null),row('proposal','main')]).map(v=>[v.branch.id,v.depth])).toEqual([['main',0],['proposal',1],['child',2]]);
});
it('keeps imported orphans and cycles reachable without recursion loops',()=>{
 const result=branchTree([row('main',null),row('orphan','missing'),row('a','b'),row('b','a')]);
 expect(result.map(v=>v.branch.id)).toEqual(['main','orphan','a','b']);expect(new Set(result.map(v=>v.branch.id)).size).toBe(4);
});
