import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: '小小汉字 · Little Hanzi',
  description: '听一听，认一认，写一写。为孩子设计的中文小课堂。',
  appleWebApp: { capable: true, statusBarStyle: 'default', title: '小小汉字' },
  metadataBase: new URL(process.env.NEXT_PUBLIC_SITE_URL || 'http://localhost:4173'),
  icons: { icon: '/favicon.svg' },
  openGraph: { title:'小小汉字 · Little Hanzi', description:'Listen. Read. Write. A little Chinese every day.', images:[{url:'/og.png',width:1200,height:630}] },
  twitter: { card:'summary_large_image', title:'小小汉字 · Little Hanzi', description:'Listen. Read. Write.', images:['/og.png'] },
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="zh-CN"><body>{children}</body></html>;
}
