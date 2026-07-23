export function SilverfishMark({ size = 24, className }: { size?: number; className?: string }) {
  return (
    <svg
      aria-hidden="true"
      className={className}
      fill="none"
      height={size}
      viewBox="0 0 32 32"
      width={size}
    >
      <path d="M7.5 7.8c4.8-3.3 12.2-3.3 17 0M9.5 11.6c3.9-2.5 9.1-2.5 13 0M11.5 15.2c2.8-1.7 6.2-1.7 9 0M13.3 18.4c1.7-.9 3.7-.9 5.4 0" stroke="currentColor" strokeLinecap="round" strokeWidth="1.9" />
      <path d="M16 18.5V29M14.8 18.8l-4.4 8.3M17.2 18.8l4.4 8.3" stroke="currentColor" strokeLinecap="round" strokeWidth="1.7" />
    </svg>
  );
}
