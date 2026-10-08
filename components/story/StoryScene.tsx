import styles from './story.module.css';
export default function StoryScene({ book = false }: { book?: boolean }) {
  return (
    <svg
      className={styles.scene}
      viewBox="0 0 560 170"
      aria-label={
        book
          ? 'A book in a shady reading place'
          : 'A little wood with a shady reading place'
      }
    >
      <path d="M0 145Q110 122 240 145T560 140V170H0Z" fill="#dceee9" />
      <path
        d="M105 128V70M440 132V56M330 138V82"
        stroke="#805010"
        strokeWidth="10"
      />
      <path d="M65 90Q40 45 100 32Q155 30 149 90Z" fill="#117c72" />
      <path d="M393 78Q384 19 440 14Q503 20 491 79Z" fill="#117c72" />
      <path d="M295 96Q271 50 331 43Q380 50 369 98Z" fill="#245bd6" />
      {book && (
        <>
          <path
            d="M203 121Q224 112 246 121V144Q224 136 203 142ZM246 121Q268 112 289 121V142Q268 136 246 144Z"
            fill="#fff"
            stroke="#245bd6"
            strokeWidth="3"
          />
          <path d="M244 146L270 156" stroke="#f4b58a" strokeWidth="6" />
        </>
      )}
    </svg>
  );
}
