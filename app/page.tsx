import { Observatory } from '@/components/Observatory';

/**
 * The app is one page.
 *
 * There is nothing to render on the server: the entire experience is a 3D scene
 * built from catalogues fetched at runtime and media that never leaves the
 * device. No backend, and nothing to prerender that would not immediately be
 * replaced.
 */
export default function Home() {
  return (
    <main className="h-full w-full">
      <Observatory />
    </main>
  );
}
