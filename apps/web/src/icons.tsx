interface P {
  className?: string;
}
const S = ({ className, children }: P & { children: React.ReactNode }) => (
  <svg
    className={className}
    width="20"
    height="20"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.7"
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    {children}
  </svg>
);

export const IconPlus = (p: P) => (
  <S {...p}>
    <circle cx="12" cy="12" r="9" />
    <path d="M12 8v8M8 12h8" />
  </S>
);
export const IconAssistant = (p: P) => (
  <S {...p}>
    <rect x="4" y="7" width="16" height="12" rx="3" />
    <path d="M12 3v4M9 13h.01M15 13h.01" />
  </S>
);
export const IconProject = (p: P) => (
  <S {...p}>
    <path d="M3 7a2 2 0 0 1 2-2h4l2 2h6a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
  </S>
);
export const IconExpert = (p: P) => (
  <S {...p}>
    <circle cx="12" cy="8" r="4" />
    <path d="M4 20c0-4 4-6 8-6s8 2 8 6" />
  </S>
);
export const IconAuto = (p: P) => (
  <S {...p}>
    <circle cx="12" cy="12" r="8" />
    <path d="M12 8v4l3 2" />
  </S>
);
export const IconLibrary = (p: P) => (
  <S {...p}>
    <path d="M4 5v14M8 5v14" />
    <path d="M12 5h8v14h-8z" />
  </S>
);
export const IconMore = (p: P) => (
  <S {...p}>
    <circle cx="5" cy="12" r="1.5" />
    <circle cx="12" cy="12" r="1.5" />
    <circle cx="19" cy="12" r="1.5" />
  </S>
);
export const IconSearch = (p: P) => (
  <S {...p}>
    <circle cx="11" cy="11" r="7" />
    <path d="m21 21-4.3-4.3" />
  </S>
);
export const IconSend = (p: P) => (
  <S {...p}>
    <path d="M12 19V5M5 12l7-7 7 7" />
  </S>
);
export const IconDoc = (p: P) => (
  <S {...p}>
    <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" />
    <path d="M14 3v5h5" />
  </S>
);
export const IconChart = (p: P) => (
  <S {...p}>
    <path d="M3 3v18h18" />
    <path d="M7 15l3-4 3 2 4-6" />
  </S>
);
export const IconFinance = (p: P) => (
  <S {...p}>
    <circle cx="12" cy="12" r="9" />
    <path d="M12 7v10M9.5 9.5h4a1.5 1.5 0 0 1 0 3h-3a1.5 1.5 0 0 0 0 3h4" />
  </S>
);
export const IconSlides = (p: P) => (
  <S {...p}>
    <rect x="3" y="4" width="18" height="12" rx="2" />
    <path d="M12 16v4M8 20h8" />
  </S>
);
export const IconGrid = (p: P) => (
  <S {...p}>
    <rect x="3" y="3" width="7" height="7" rx="1.5" />
    <rect x="14" y="3" width="7" height="7" rx="1.5" />
    <rect x="3" y="14" width="7" height="7" rx="1.5" />
    <rect x="14" y="14" width="7" height="7" rx="1.5" />
  </S>
);
export const IconCheck = (p: P) => (
  <S {...p}>
    <path d="M20 6 9 17l-5-5" />
  </S>
);
export const IconStop = (p: P) => (
  <S {...p}>
    <rect x="6" y="6" width="12" height="12" rx="2" />
  </S>
);
export const IconTerminal = (p: P) => (
  <S {...p}>
    <rect x="3" y="4" width="18" height="16" rx="2" />
    <path d="m7 9 3 3-3 3M13 15h4" />
  </S>
);
export const IconFile = (p: P) => (
  <S {...p}>
    <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" />
    <path d="M14 3v5h5" />
  </S>
);
export const IconDownload = (p: P) => (
  <S {...p}>
    <path d="M12 3v12m0 0 4-4m-4 4-4-4" />
    <path d="M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2" />
  </S>
);
export const IconEdit = (p: P) => (
  <S {...p}>
    <path d="M12 20h9" />
    <path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z" />
  </S>
);
export const IconSpark = (p: P) => (
  <S {...p}>
    <path d="M12 3v4M12 17v4M3 12h4M17 12h4M6 6l2.5 2.5M15.5 15.5 18 18M18 6l-2.5 2.5M8.5 15.5 6 18" />
  </S>
);
