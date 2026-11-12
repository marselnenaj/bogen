export default function Badge({ label = 'New', count = 0, solid = false }) {
  return <span className={solid ? 'rounded-full bg-zinc-900 px-2 text-white' : 'rounded-full border px-2'}>{label}{count ? ` ${count}` : ''}</span>;
}
