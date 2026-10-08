import Image, { type ImageProps } from 'next/image';
import type { SVGProps } from 'react';

export function PilotAscentIllustration(props: SVGProps<SVGSVGElement>) {
  return (
    <svg
      viewBox="0 0 520 340"
      aria-label="An open path ascending through a small forest"
      {...props}
    >
      <path
        d="M34 292c95-16 148-5 205-38 62-36 83-94 150-113 42-12 76-8 108 8"
        fill="none"
        stroke="#245bd6"
        strokeLinecap="round"
        strokeWidth="7"
        opacity=".2"
      />
      <path
        d="M38 294c96-17 145-7 202-40 63-36 83-96 149-115 41-12 76-8 109 9"
        fill="none"
        stroke="#245bd6"
        strokeLinecap="round"
        strokeWidth="3"
      />
      <path
        d="M122 260V151m49 102V108m207 0v-55m-47 75V69"
        fill="none"
        stroke="#117c72"
        strokeLinecap="round"
        strokeWidth="9"
      />
      <path
        d="M85 174c14-41 46-56 76-39 1-39 24-67 57-67 29 0 49 24 48 55 36-16 68 8 68 46"
        fill="#cde4dd"
        stroke="#117c72"
        strokeWidth="4"
      />
      <path
        d="M319 83c10-27 32-39 54-30-2-28 15-51 40-51 23 0 40 18 39 43 27-11 51 5 53 31"
        fill="#b9ddcc"
        stroke="#117c72"
        strokeWidth="4"
      />
      <path
        d="M91 263h85m199-4h93"
        stroke="#182c49"
        strokeLinecap="round"
        strokeWidth="5"
        opacity=".2"
      />
      <circle cx="435" cy="43" r="22" fill="#f4b58a" opacity=".9" />
      <path d="M436 17l3 17 16 4-16 4-3 17-4-17-16-4 16-4z" fill="#fff" />
      <path
        d="M245 228c10-15 26-18 41-9-4 15-19 24-34 22"
        fill="#f4b58a"
        stroke="#a55b2a"
        strokeWidth="3"
      />
    </svg>
  );
}

export function PilotCompanion({
  style,
  ...props
}: Omit<ImageProps, 'src' | 'alt'>) {
  return (
    <Image
      src="/mascot/capybara-welcome-v5.png"
      alt="A friendly upright capybara wearing a navy school uniform, matching cap and teal scarf"
      width={144}
      height={160}
      unoptimized
      style={{ objectFit: 'contain', ...style }}
      {...props}
    />
  );
}
