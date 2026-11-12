import {
  applyRepeat, bindLayer, deleteDataSource, getDataSource, getRepeatBinding, listDataSources, parseRecords, recordsFrom,
  repeatsOfSource, rerunSource, setDataSource, type DataRecord, type DataSource, type RepeatSource,
} from '@bogen/core';
import { z } from 'zod';
import { fetchRecords } from '../http/transfer-routes.ts';
import { errorMessage } from '../util.ts';
import { assertUnlocked, fileIdArg, type ToolDefiner } from './kit.ts';

/**
 * Designs from data: the file's data sources, repeats over them, and bindings of layers to fields. An agent only
 * ever fetches public addresses. This computer's own network is for a person at this machine, from the Data panel.
 */
async function agentFetch(url: string, options: { path?: string; format?: 'json' | 'csv' }): Promise<DataRecord[]> {
  try {
    return await fetchRecords(url, options);
  } catch (e) {
    const message = errorMessage(e);
    if (/private/i.test(message)) throw new Error(`${message} An agent only reaches public addresses. A person at this computer can add a local address in the Data panel, with "Allow this computer's network".`);
    throw e;
  }
}

function summary(s: DataSource, repeats: string[]) {
  return {
    id: s.id, name: s.name, kind: s.kind, ...(s.url ? { url: s.url } : {}), ...(s.path ? { path: s.path } : {}),
    records: s.records.length, fields: s.fields, first: s.records[0], updated: new Date(s.updatedAt).toISOString(), templates: repeats,
    ...(s.allowLocal ? { local: true } : {}),
  };
}

const RECORDS = 'JSON (a list of objects, or an object with one list in it) or CSV with a header row.';

export function registerDataTools(define: ToolDefiner): void {
  define('data_source_list', { description: 'The data sources of a file: named lists of records that templates repeat over, with their fields, the first record and the templates bound to each.', readOnly: true }, { file_id: fileIdArg }, async ({ file_id }, ctx) => {
    const room = await ctx.room(file_id);
    return { sources: listDataSources(room.doc).map((s) => summary(s, repeatsOfSource(room.doc, s.id))) };
  });

  define('data_source_set', { description: 'Add a data source to the file, or replace the records of one by name: pasted JSON or CSV you have read, or a public URL that returns them. The records are kept in the file, so the design shows them on every device and offline. Every template bound to the source runs again. Then bind templates with layer_repeat {source}.' }, {
    name: z.string().min(1).max(200).describe('Such as Products. A source with this name is replaced.'),
    data: z.string().max(4 * 1024 * 1024).optional().describe(RECORDS),
    url: z.string().url().optional().describe('A public address returning JSON or CSV. Private addresses are refused.'),
    path: z.string().max(200).optional().describe('Where the list is in the JSON, such as data.items.'),
    format: z.enum(['json', 'csv']).optional().describe('By default it is told from the content.'),
    file_id: fileIdArg,
  }, async ({ name, data, url, path, format, file_id }, ctx) => {
    if (Boolean(data) === Boolean(url)) throw new Error('Give data or url, one of them.');
    const room = await ctx.room(file_id);
    if (url && ctx.dryRun) throw new Error('data_source_set with a url reaches the network, so it does not run in a dry run.');
    const records = url ? await agentFetch(url, { path, format }) : parseRecords(data!, { path, format });
    const out = ctx.write(room, () => {
      const source = setDataSource(room.doc, { name, kind: url ? 'url' : 'inline', ...(url ? { url } : {}), ...(path ? { path } : {}), ...(format ? { format } : {}), records });
      return { source, reran: rerunSource(room.doc, source.id) };
    });
    ctx.touch(out.reran.flatMap((r) => r.copies));
    return { ...summary(out.source, repeatsOfSource(room.doc, out.source.id)), reran: out.reran.map((r) => ({ template: r.templateId, copies: r.copies.length, missing: r.missing })) };
  });

  define('data_source_refresh', { description: 'Fetch a URL source again and run every template bound to it, as one undo step. A pasted source runs its templates again from the records it has.' }, {
    source: z.string().describe('The source, by id or name.'),
    file_id: fileIdArg,
  }, async ({ source, file_id }, ctx) => {
    const room = await ctx.room(file_id);
    const s = getDataSource(room.doc, source);
    if (!s) throw new Error(`No data source "${source}". Call data_source_list.`);
    let records = s.records;
    if (s.kind === 'url' && s.url) {
      if (s.allowLocal) throw new Error(`${s.name} reads from this computer's own network, which only a person at this computer refreshes, in the Data panel. Its templates can run again from the records it has with layer_repeat.`);
      if (ctx.dryRun) throw new Error('data_source_refresh reaches the network, so it does not run in a dry run.');
      records = await agentFetch(s.url, { path: s.path, format: s.format });
    }
    const out = ctx.write(room, () => {
      const next = s.kind === 'url' ? setDataSource(room.doc, { id: s.id, name: s.name, kind: s.kind, url: s.url, path: s.path, format: s.format, records }) : s;
      return { source: next, reran: rerunSource(room.doc, s.id) };
    });
    ctx.touch(out.reran.flatMap((r) => r.copies));
    return { ...summary(out.source, repeatsOfSource(room.doc, s.id)), reran: out.reran.map((r) => ({ template: r.templateId, copies: r.copies.length, missing: r.missing })) };
  });

  define('data_source_delete', { description: 'Remove a data source from the file. Templates bound to it keep their copies as they are, and need another source to run again.', destructive: true }, {
    source: z.string(),
    file_id: fileIdArg,
  }, async ({ source, file_id }, ctx) => {
    const room = await ctx.room(file_id);
    const templates = getDataSource(room.doc, source) ? repeatsOfSource(room.doc, getDataSource(room.doc, source)!.id) : [];
    const deleted = ctx.write(room, () => deleteDataSource(room.doc, source));
    if (!deleted) throw new Error(`No data source "${source}". Call data_source_list.`);
    return { deleted: true, templates_left: templates };
  });

  define('layer_bind', { description: 'Bind a layer of a template to fields of the records: its text, image source, attributes (alt, href), whether it shows (visible: shown when the field is truthy; empty, 0, false and no are not), and on an instance its props and variant axes (the variant is picked from the field\'s value). It writes {{field}} placeholders and bind attributes; layer_repeat then fills one copy per record. A field of null takes the binding away.' }, {
    node_id: z.string(),
    text: z.string().nullable().optional().describe('Field for the whole text.'),
    src: z.string().nullable().optional().describe('Field for an image or video source.'),
    visible: z.string().nullable().optional().describe('Field that decides whether it shows.'),
    variant: z.record(z.string(), z.string().nullable()).optional().describe('On an instance: axis to field, such as {"tier":"tier"}.'),
    props: z.record(z.string(), z.string().nullable()).optional().describe('On an instance: prop to field, such as {"label":"name"}.'),
    attrs: z.record(z.string(), z.string().nullable()).optional().describe('Attribute to field, such as {"alt":"name"}.'),
    file_id: fileIdArg,
  }, async ({ node_id, file_id, ...patch }, ctx) => {
    const room = await ctx.room(file_id);
    assertUnlocked(room.doc, [node_id]);
    const bound = ctx.write(room, () => bindLayer(room.doc, node_id, patch));
    ctx.touch([node_id]);
    return { node_id, bindings: bound, next: 'Run layer_repeat on the template to make the copies, or again to refresh them.' };
  });

  define('layer_repeat', { description: 'Bind a template layer to data: one copy per record right after the template, with {{field}} placeholders filled in its text, image sources, attributes, styles and instance props ({{a.b}} reaches inside), and the bindings layer_bind set (visible, variant). The template stays hidden, and running this again replaces the copies, which is how data refreshes. Inside a flex or grid parent the copies lay out like any children. Give source (a data source of the file, see data_source_set), data as JSON or CSV text you have read, or url for a public REST address. record makes one copy of one record, such as a profile. Without data, url or source it runs again from the source it has.' }, {
    node_id: z.string().describe('The template layer.'),
    source: z.string().optional().describe('A data source of the file, by id or name.'),
    data: z.string().max(4 * 1024 * 1024).optional().describe(RECORDS),
    url: z.string().url().optional().describe('A public address returning JSON or CSV. Private addresses are refused.'),
    path: z.string().max(200).optional().describe('Where the list is in the JSON, such as data.items.'),
    format: z.enum(['json', 'csv']).optional().describe('By default it is told from the content.'),
    record: z.number().int().min(0).nullable().optional().describe('Bind this one record, counted from 0, instead of the list. null goes back to the list.'),
    file_id: fileIdArg,
  }, async ({ node_id, source: sourceRef, data, url, path, format, record, file_id }, ctx) => {
    const room = await ctx.room(file_id);
    assertUnlocked(room.doc, [node_id]);
    if ([data, url, sourceRef].filter(Boolean).length > 1) throw new Error('Give one of source, data and url.');
    const previous = getRepeatBinding(room.doc, node_id);
    const one = record === undefined ? (previous?.source.record !== undefined ? { record: previous.source.record } : {}) : record === null ? {} : { record };
    let records: DataRecord[];
    let source: RepeatSource;
    const named = sourceRef ?? (!data && !url && previous?.source.kind === 'source' ? previous.source.source : undefined);
    const fetchFrom = url ?? (!data && !named && previous?.source.kind === 'url' ? previous.source.url : undefined);
    if (named) {
      const s = getDataSource(room.doc, named);
      if (!s) throw new Error(`No data source "${named}". Call data_source_list, or add one with data_source_set.`);
      records = s.records;
      source = { kind: 'source', source: s.id, ...one };
    } else if (fetchFrom) {
      if (ctx.dryRun) throw new Error('layer_repeat with a url reaches the network, so it does not run in a dry run.');
      const usePath = path ?? (url ? undefined : previous?.source.path);
      const useFormat = format ?? (url ? undefined : previous?.source.format);
      records = await agentFetch(fetchFrom, { path: usePath, format: useFormat });
      source = { kind: 'url', url: fetchFrom, ...(usePath ? { path: usePath } : {}), ...(useFormat ? { format: useFormat } : {}), ...one };
    } else if (data) {
      records = parseRecords(data, { format, path });
      source = { kind: 'inline', ...(path ? { path } : {}), ...(format ? { format } : {}), ...one };
    } else if (previous?.records) {
      records = recordsFrom(previous.records);
      source = { ...previous.source, record: undefined, ...one };
      if (source.record === undefined) delete source.record;
    } else throw new Error('Give source, data or url: this layer has not been repeated before.');
    const result = ctx.write(room, () => applyRepeat(room.doc, node_id, records, source));
    ctx.touch(result.copies);
    return { template: result.templateId, copies: result.copies.length, ids: result.copies.slice(0, 50), fields: result.fields, missing: result.missing, refused: result.refused, ...(result.warning ? { warning: result.warning } : {}), source };
  });
}
