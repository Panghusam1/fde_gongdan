type IconProps = {
  className?: string;
};

export function ArrowUpRight({ className }: IconProps) {
  return (
    <svg className={className} viewBox="0 0 20 20" aria-hidden="true">
      <path d="M5 15 15 5M7 5h8v8" fill="none" stroke="currentColor" strokeWidth="1.5" />
    </svg>
  );
}

export function ArrowLeft({ className }: IconProps) {
  return (
    <svg className={className} viewBox="0 0 20 20" aria-hidden="true">
      <path d="m12 5-5 5 5 5M7 10h9" fill="none" stroke="currentColor" strokeWidth="1.5" />
    </svg>
  );
}

export function Crosshair({ className }: IconProps) {
  return (
    <svg className={className} viewBox="0 0 32 32" aria-hidden="true">
      <circle cx="16" cy="16" r="5" fill="none" stroke="currentColor" />
      <path d="M16 2v8M16 22v8M2 16h8M22 16h8" fill="none" stroke="currentColor" />
    </svg>
  );
}

export function Plus({ className }: IconProps) {
  return (
    <svg className={className} viewBox="0 0 20 20" aria-hidden="true">
      <path d="M10 3v14M3 10h14" fill="none" stroke="currentColor" strokeWidth="1.25" />
    </svg>
  );
}
