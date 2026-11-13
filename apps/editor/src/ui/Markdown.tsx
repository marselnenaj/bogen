import { Fragment, memo, type ReactNode } from 'react';
import { parseMarkdown, type Block, type Inline } from './markdown.ts';

/** An agent's words as markdown, drawn as React elements only: see markdown.ts. */
export const Markdown = memo(function Markdown({ text, className = 'md' }: { text: string; className?: string }) {
  return <div className={className} dir="auto">{parseMarkdown(text).map(block)}</div>;
});

function block(b: Block, key: number): ReactNode {
  switch (b.t) {
    case 'p': return <p key={key}>{spans(b.children)}</p>;
    case 'h': return b.level === 1 ? <h3 key={key}>{spans(b.children)}</h3> : <h4 key={key}>{spans(b.children)}</h4>;
    case 'ul': return <ul key={key}>{b.items.map((item, i) => <li key={i}>{spans(item)}</li>)}</ul>;
    case 'ol': return <ol key={key} start={b.start}>{b.items.map((item, i) => <li key={i}>{spans(item)}</li>)}</ol>;
    case 'quote': return <blockquote key={key}>{spans(b.children)}</blockquote>;
    case 'pre': return <pre key={key} dir="ltr"><code>{b.text}</code></pre>;
  }
}

function spans(nodes: Inline[]): ReactNode {
  return nodes.map((n, i) => {
    switch (n.t) {
      case 'text': return <Fragment key={i}>{n.text}</Fragment>;
      case 'code': return <code key={i}>{n.text}</code>;
      case 'strong': return <strong key={i}>{spans(n.children)}</strong>;
      case 'em': return <em key={i}>{spans(n.children)}</em>;
      case 'link': return <a key={i} href={n.href} target="_blank" rel="noopener noreferrer">{spans(n.children)}</a>;
      case 'br': return <br key={i} />;
    }
  });
}
