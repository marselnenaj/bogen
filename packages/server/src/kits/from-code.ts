import type { CodePropValue } from '@bogen/core';
import type { CodeComponentInfo, CodeProject } from '../code-projects.ts';
import { eachAxis } from './markup.ts';
import type { Kit, KitComponent } from './types.ts';

/**
 * A kit from a linked repository's own design system: each React component the project scan finds is a
 * component of the kit, rendered by the project's code, with its enum props (such as cva's `variant` and `size`)
 * as variant axes and its own import as the handoff. A Storybook import makes a Kit the same way and calls
 * registerKit; this is the one that needs nothing but the source.
 */
const MAX_COMPONENTS = 40;
const MAX_VALUES = 6;
const MAX_AXES = 2;

/** The id of the kit made from a project, stable on this device. */
export function codeKitId(project: CodeProject): string {
  return `code-${project.id.slice(0, 12)}`;
}

export function kitFromProject(project: CodeProject, components: CodeComponentInfo[], only?: string[]): Kit {
  const wanted = only?.map((n) => n.toLowerCase());
  const picked = components
    .filter((c) => /^[A-Z]/.test(c.name) && (!wanted || wanted.includes(c.name.toLowerCase()) || wanted.includes(c.display.toLowerCase())))
    .slice(0, MAX_COMPONENTS);
  if (!picked.length) throw new Error(only ? `None of ${only.join(', ')} is a component in ${project.name}. See code_components_list.` : `${project.name} has no React components that Bogen could read.`);
  const kitComponents: KitComponent[] = picked.map((c) => {
    const enums = c.props.filter((p) => p.type === 'enum' && p.options?.length && p.options.length > 1).slice(0, MAX_AXES);
    // The default first, as a kit's axes say it, so that the first member is how the component looks bare.
    const axes = Object.fromEntries(enums.map((p) => {
      const options = p.options!.slice(0, MAX_VALUES);
      const first = typeof p.default === 'string' && options.includes(p.default) ? p.default : options[0]!;
      return [p.name, [first, ...options.filter((o) => o !== first)]];
    }));
    const children = c.props.find((p) => p.name === 'children');
    return {
      name: c.display,
      group: groupOf(c.file),
      description: `${c.name} from ${c.file}.`,
      ...(enums.length ? { axes, members: eachAxis(axes) } : {}),
      code: {
        project: project.id, file: c.file, name: c.name, import: c.import,
        props: (variant) => ({ ...variant, ...(children ? { children: c.display } : {}) } as Record<string, CodePropValue>),
      },
      handoff: { from: c.import, name: c.name === 'default' ? pascal(c.display) : c.name },
    };
  });
  return {
    id: codeKitId(project),
    name: project.name,
    description: `The components of ${project.name}, rendered by its own code.`,
    platform: 'web',
    library: { name: project.name, package: project.name, license: 'the project\'s own', url: '' },
    font: 'inherit',
    version: 1,
    tokens: [],
    components: kitComponents,
    source: 'code',
  };
}

function groupOf(file: string): string {
  const dir = file.split('/').slice(0, -1).at(-1) ?? '';
  return dir && !/^(src|components|ui|lib)$/.test(dir) ? dir[0]!.toUpperCase() + dir.slice(1) : 'Components';
}

function pascal(name: string): string {
  const out = name.replace(/[^\w]+(.)/g, (_, c: string) => c.toUpperCase()).replace(/^./, (c) => c.toUpperCase());
  return /^[A-Z][\w$]*$/.test(out) ? out : 'Component';
}
