import { Fragment, type ReactNode } from 'react';

/**
 * A short run of facts about one thing, such as "Desktop, 3 branches, Nov 9": each fact is its own piece of text with
 * a quiet dot between, so that each can be read, styled and wrapped on its own instead of one string strung with dots.
 * Empty facts are left out. With `cutTitle` the facts are a tooltip only while they are cut off (ui/tooltip.ts).
 */
export function Facts({ items, className, testId, title, cutTitle }: { items: (ReactNode | null | undefined | false)[]; className?: string; testId?: string; title?: string; cutTitle?: boolean }) {
  const shown = items.filter((i): i is ReactNode => i !== null && i !== undefined && i !== false && i !== '');
  return (
    <span className={className} data-testid={testId} title={title} data-title-if-cut={cutTitle ? factsText(shown.filter((i): i is string => typeof i === 'string')) : undefined}>
      {shown.map((item, i) => (
        <Fragment key={i}>
          {i ? <span className="facts-dot" aria-hidden="true">·</span> : null}
          <span className="facts-item">{item}</span>
        </Fragment>
      ))}
    </span>
  );
}

/** The facts as one line of words, for a title or a screen reader. */
export const factsText = (items: (string | null | undefined | false)[]): string => items.filter(Boolean).join(', ');
