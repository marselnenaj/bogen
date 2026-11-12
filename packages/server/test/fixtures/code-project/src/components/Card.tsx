import mark from '../assets/mark.svg';

interface CardProps {
  title: string;
  body?: string;
  /** Draws a brand ring around the card. */
  highlighted?: boolean;
  count?: number;
}

export const Card = ({ title, body = 'Nothing here yet.', highlighted = false, count }: CardProps) => (
  <section className={`flex w-80 flex-col gap-2 rounded-2xl bg-white p-6 shadow-md ${highlighted ? 'ring-2 ring-brand' : ''}`}>
    <img src={mark} alt="" className="size-6" />
    <h2 className="text-xl font-semibold tracking-tight">{title}</h2>
    <p className="text-sm text-zinc-600">{body}</p>
    {count !== undefined && <p className="text-xs text-zinc-500">{count} items</p>}
  </section>
);

export default Card;
