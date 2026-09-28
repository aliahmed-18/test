/** "Getit" wordmark – the "i" is bold and slightly larger. */
export function Logo({ size = 'md' }: { size?: 'md' | 'lg' }) {
  const text = size === 'lg' ? 'text-5xl' : 'text-2xl'
  return (
    <span className={`${text} font-semibold tracking-tight text-ink`} aria-label="Getit">
      Get<span className="text-[1.22em] leading-none font-extrabold text-brand">i</span>t
    </span>
  )
}
