import type { SVGProps } from 'react';

export function ForestIllustration(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 440 300" aria-label="A small illustrated forest with two trees" {...props}>
      <path d="M28 278c72-16 126-6 185-14 74-10 119-23 199-3" fill="none" stroke="#245bd6" strokeLinecap="round" strokeWidth="4" opacity=".25" />
      <path d="M62 265c18-59 28-94 41-159M109 265c-8-55-7-91-3-159M193 270c-9-63-2-117 21-185M254 270c3-54 18-111 49-161" fill="none" stroke="#117c72" strokeLinecap="round" strokeWidth="8" />
      <path d="M35 236c10-35 36-49 62-34-1-36 18-62 50-61 26 1 45 19 48 47 30-17 64-3 69 31 31-17 67-1 70 33" fill="#b9ddcc" stroke="#117c72" strokeWidth="4" />
      <path d="M208 184c9-32 35-49 64-37-2-40 19-68 53-67 29 1 49 25 48 56 31-14 60 8 56 43 9 0 17 2 24 7" fill="#cde4dd" stroke="#117c72" strokeWidth="4" />
      <path d="M44 264h348" fill="none" stroke="#182c49" strokeLinecap="round" strokeWidth="5" opacity=".22" />
      <circle cx="332" cy="41" r="20" fill="#f4b58a" opacity=".85" />
      <path d="m332 14 3 16 15 3-15 4-3 16-4-16-15-4 15-3z" fill="#fff" opacity=".9" />
      <path d="M91 213c9 0 16 7 16 16s-7 16-16 16-16-7-16-16 7-16 16-16Zm5 12-4 4-4-4m3 10h8" fill="none" stroke="#182c49" strokeLinecap="round" strokeWidth="3" />
      <path d="M289 234c9-13 23-16 37-9-4 13-16 21-29 20" fill="#f4b58a" stroke="#a55b2a" strokeWidth="3" />
    </svg>
  );
}

export function ReadingIllustration({ panel = 1, ...props }: SVGProps<SVGSVGElement> & { panel?: 1 | 2 }) {
  if (panel === 2) {
    return (
      <svg viewBox="0 0 280 210" aria-label="A bird resting beside a grove" {...props}>
        <circle cx="221" cy="42" r="25" fill="#f4b58a" opacity=".85" />
        <path d="M30 166c45-11 77-10 114 0 41 11 79 5 112-4" fill="none" stroke="#245bd6" strokeLinecap="round" strokeWidth="5" opacity=".3" />
        <path d="M60 168V92m45 76V70m52 100V80m47 87V91" stroke="#117c72" strokeLinecap="round" strokeWidth="7" />
        <path d="M27 108c12-34 36-46 61-37 3-31 26-52 52-49 23 3 37 22 36 47 27-13 54 5 59 35" fill="#b9ddcc" stroke="#117c72" strokeWidth="4" />
        <path d="M113 99c13-16 31-14 41-1-8 14-23 17-37 10m7-10 14 0" fill="#182c49" stroke="#182c49" strokeWidth="3" />
        <circle cx="143" cy="95" r="2.8" fill="#fff" />
        <path d="M113 109c-8 11-13 18-15 29m42-30c10 8 19 15 25 25" fill="none" stroke="#182c49" strokeLinecap="round" strokeWidth="3" />
      </svg>
    );
  }
  return (
    <svg viewBox="0 0 280 210" aria-label="A simple piece of wood on the ground" {...props}>
      <circle cx="210" cy="42" r="24" fill="#f4b58a" opacity=".85" />
      <path d="M40 166c51-9 92-9 132 0 34 8 57 7 85-1" fill="none" stroke="#245bd6" strokeLinecap="round" strokeWidth="5" opacity=".3" />
      <path d="M54 119c17-19 47-27 91-24l58 4c22 2 36 15 37 30 1 16-13 28-35 31l-107 6c-34 2-55-6-59-22-3-9 3-18 15-25Z" fill="#f4b58a" stroke="#a55b2a" strokeWidth="4" />
      <ellipse cx="201" cy="130" rx="24" ry="26" fill="#f8c99f" stroke="#a55b2a" strokeWidth="4" />
      <ellipse cx="201" cy="130" rx="12" ry="14" fill="none" stroke="#a55b2a" strokeWidth="3" opacity=".8" />
      <path d="M78 123c20 5 37 4 55-2m-58 17c21 5 42 4 62-3" fill="none" stroke="#a55b2a" strokeLinecap="round" strokeWidth="4" opacity=".75" />
      <path d="M69 169c28-8 83-8 128 0" fill="none" stroke="#182c49" strokeLinecap="round" strokeWidth="4" opacity=".5" />
    </svg>
  );
}
