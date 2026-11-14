import { useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { Play } from "lucide-react";
import { PublicLayout, PublicPageHead } from "../components/PublicLayout";
import { useAuth } from "../context/AuthContext";
import { useHorizontalTabKeys } from "../lib/hooks";
import { TUTORIALS } from "../lib/marketingContent";
import { WEB_TUTORIAL_VIDEOS, youtubeEmbedUrl, type TutorialVideo } from "../lib/tutorialVideos";

/**
 * Tutorials, split by platform. The web tab plays the recorded chapter videos;
 * the Android tab keeps the six written walkthroughs (lib/marketingContent, the
 * same six the app's Help section teaches) until Android videos exist.
 */

const PLATFORMS = [
  { id: "web", label: "Web app" },
  { id: "android", label: "Android app" },
] as const;
type Platform = (typeof PLATFORMS)[number]["id"];

export function Tutorials() {
  const { profile } = useAuth();
  const [params, setParams] = useSearchParams();
  const platform: Platform = params.get("platform") === "android" ? "android" : "web";
  const onTabKeys = useHorizontalTabKeys();

  return (
    <PublicLayout>
      <PublicPageHead
        eyebrow="Help Center"
        title="Tutorials"
        lede="Step by step, from setting up your business to reading what the dashboard is telling you."
      />

      <div className="mx-auto max-w-[1240px] px-4 py-14 lg:px-6 lg:py-20">
        <div role="tablist" aria-label="Tutorial platform" aria-orientation="horizontal" onKeyDown={onTabKeys} className="inline-flex max-w-full flex-wrap gap-1 rounded-full border border-landing-mint-light/70 bg-landing-surface p-1 shadow-sm">
          {PLATFORMS.map(({ id, label }) => (
            <button
              key={id}
              type="button"
              role="tab"
              id={`tutorials-tab-${id}`}
              aria-selected={platform === id}
              aria-controls="tutorials-panel"
              tabIndex={platform === id ? 0 : -1}
              onClick={() => setParams(id === "web" ? {} : { platform: id }, { replace: true })}
              className={`inline-flex min-h-tap items-center justify-center rounded-full px-5 text-sm font-semibold transition-colors ${platform === id ? "bg-landing-emerald text-white" : "text-landing-muted hover:bg-landing-mint-pale hover:text-landing-charcoal"}`}
            >
              {label}
            </button>
          ))}
        </div>

        <div role="tabpanel" id="tutorials-panel" aria-labelledby={`tutorials-tab-${platform}`} className="mt-10">
          {platform === "web" ? <WebVideos /> : <AndroidGuides />}
        </div>

        <div className="mt-12 flex flex-col items-center justify-between gap-5 rounded-2xl bg-landing-emerald px-6 py-7 text-center sm:flex-row sm:text-left lg:px-8">
          <p className="max-w-xl text-sm leading-relaxed text-white/85">
            {profile
              ? "The in-app tour walks through the same screens on your own dashboard."
              : "The quickest way to learn it is to record one week of your own figures."}
          </p>
          <div className="mt-4">
            {/* Signed in, an account invitation is no use; the tour is the walkthrough on their own data. */}
            <Link
              to={profile ? "/dashboard?tour=start" : "/register"}
              className="tap inline-flex whitespace-nowrap rounded-full bg-landing-gold px-5 text-sm font-bold text-landing-emerald transition hover:brightness-95"
            >
              {profile ? "Take the in-app tour" : "Create a free account"}
            </Link>
          </div>
        </div>
      </div>
    </PublicLayout>
  );
}

function WebVideos() {
  return (
    <div className="space-y-14">
      {WEB_TUTORIAL_VIDEOS.map((group, i) => (
        <section key={group.title} aria-labelledby={`tutorials-group-${i}`}>
          <h2 id={`tutorials-group-${i}`} className="font-landing-display text-xl font-semibold text-landing-charcoal">{group.title}</h2>
          <ul className="mt-5 grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
            {group.videos.map((video) => <VideoCard key={video.code} video={video} />)}
          </ul>
        </section>
      ))}
    </div>
  );
}

/** Loads YouTube only after the viewer asks to play, so the page stays light and cookie-free. */
function VideoCard({ video }: { video: TutorialVideo }) {
  const [playing, setPlaying] = useState(false);
  const [thumbnailFailed, setThumbnailFailed] = useState(false);
  const hasThumbnail = Boolean(video.thumbnailSrc) && !thumbnailFailed;
  const label = `${video.code} · ${video.title}`;
  return (
    <li className="min-w-0">
      <div className="aspect-video overflow-hidden rounded-xl border border-landing-mint-light/70 bg-landing-emerald">
        {!video.youtubeId ? (
          <div className="flex h-full items-center justify-center bg-landing-mint-pale">
            <p className="text-xs font-semibold text-landing-green">Video coming soon</p>
          </div>
        ) : playing ? (
          <iframe
            src={youtubeEmbedUrl(video.youtubeId)}
            title={label}
            className="h-full w-full"
            allow="autoplay; encrypted-media; picture-in-picture; fullscreen"
            allowFullScreen
            referrerPolicy="strict-origin-when-cross-origin"
          />
        ) : (
          <button
            type="button"
            onClick={() => setPlaying(true)}
            aria-label={`Play video: ${label}`}
            className="group relative flex h-full w-full flex-col items-center justify-center gap-3 text-white focus-visible:outline focus-visible:outline-4 focus-visible:-outline-offset-4 focus-visible:outline-landing-gold"
          >
            {hasThumbnail && (
              <img
                src={video.thumbnailSrc}
                alt=""
                width={960}
                height={540}
                loading="lazy"
                decoding="async"
                onError={() => setThumbnailFailed(true)}
                className="absolute inset-0 h-full w-full object-contain"
              />
            )}
            <span aria-hidden className={hasThumbnail
              ? "absolute bottom-3 left-3 flex h-10 w-10 items-center justify-center rounded-full bg-landing-emerald transition group-hover:bg-landing-green"
              : "flex h-14 w-14 items-center justify-center rounded-full bg-white/15 transition group-hover:bg-white/25"}>
              <Play className="h-6 w-6 translate-x-0.5 fill-current" />
            </span>
            <span className={hasThumbnail ? "sr-only" : "text-sm font-semibold"}>Play video</span>
          </button>
        )}
      </div>
      <p className="mt-3 text-xs font-bold uppercase tracking-[0.12em] text-landing-green">{video.code}</p>
      <h3 className="mt-1 text-sm font-semibold leading-snug text-landing-charcoal">{video.title}</h3>
    </li>
  );
}

function AndroidGuides() {
  return (
    <div className="grid gap-x-12 gap-y-0 lg:grid-cols-2">
      {TUTORIALS.map((t) => (
        <article key={t.n} className="border-b border-landing-mint-light py-7 first:pt-0 lg:[&:nth-child(2)]:pt-0">
          <div className="flex items-center gap-3">
            <span
              aria-hidden
              className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-landing-green font-landing-display text-sm font-bold text-white"
            >
              {t.n}
            </span>
            <h2 className="font-landing-display text-lg font-semibold text-landing-charcoal">{t.title}</h2>
          </div>
          <p className="mt-3 text-sm leading-relaxed text-landing-muted">{t.body}</p>
          <p className="mt-4 text-xs font-semibold text-landing-green">Video walkthrough coming soon</p>
        </article>
      ))}
    </div>
  );
}
