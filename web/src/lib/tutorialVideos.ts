/**
 * The web app's video tutorials (docs/FINSIGHT-WEB-FEATURE-TUTORIAL-SCRIPTS.md),
 * hosted as unlisted YouTube videos. A chapter with no `youtubeId` yet shows as
 * "coming soon": add its ID here once the video is uploaded.
 */
export interface TutorialVideo {
  code: string;
  title: string;
  youtubeId?: string;
  thumbnailSrc?: string;
}

export interface TutorialVideoGroup {
  title: string;
  videos: TutorialVideo[];
}

export const WEB_TUTORIAL_VIDEOS: TutorialVideoGroup[] = [
  {
    title: "Getting started",
    videos: [
      { code: "W01", title: "Register and confirm email", youtubeId: "xjJDLnzW4DU", thumbnailSrc: "/tutorials/W01.webp" },
      { code: "W02", title: "Sign in, Google sign-in and password recovery", youtubeId: "hdj3akcA120", thumbnailSrc: "/tutorials/W02.webp" },
      { code: "W03", title: "First business setup", youtubeId: "U9i3lfrvwSA", thumbnailSrc: "/tutorials/W03.webp" },
      { code: "W04", title: "Navigation, global search and guided tour", youtubeId: "m8_n15MfPUs", thumbnailSrc: "/tutorials/W04.webp" },
      { code: "W05", title: "Create, edit and switch businesses", youtubeId: "3cZvIsmgqxs", thumbnailSrc: "/tutorials/W05.webp" },
      { code: "W06", title: "Archive and restore a business", youtubeId: "BDOzaZ-9EnI", thumbnailSrc: "/tutorials/W06.webp" },
      { code: "W07", title: "Opening balance and record coverage", youtubeId: "r1LWmDqfBr8", thumbnailSrc: "/tutorials/W07.webp" },
      { code: "W08", title: "Operating schedule and special dates", youtubeId: "ds38PY_iYgw", thumbnailSrc: "/tutorials/W08.webp" },
    ],
  },
  {
    title: "Dashboard and records",
    videos: [
      { code: "W09", title: "Dashboard and financial charts", youtubeId: "f34ZGIFHaLw", thumbnailSrc: "/tutorials/W09.webp" },
      { code: "W10", title: "Create categories and classify costs", youtubeId: "n-B-i7j8pcw", thumbnailSrc: "/tutorials/W10.webp" },
      { code: "W11", title: "Add an expense and use category suggestions" },
      { code: "W12", title: "Add sales" },
      { code: "W13", title: "Search, filter, sort and inspect records" },
      { code: "W14", title: "Edit, review and delete a record" },
      { code: "W15", title: "Resolve duplicates and large expenses" },
    ],
  },
  {
    title: "Receipts and spreadsheets",
    videos: [
      { code: "W16", title: "Upload receipts, pages and separate receipts" },
      { code: "W17", title: "Receipt fields, line items and confirmation" },
      { code: "W18", title: "Receipt consent, drafts, failures and stored scans" },
      { code: "W19", title: "CSV upload, types and mapping" },
      { code: "W20", title: "CSV correction, confirmation and recovery" },
    ],
  },
  {
    title: "Insights and planning",
    videos: [
      { code: "W21", title: "Expense comparisons, unusual expenses and finding feedback" },
      { code: "W22", title: "Reduction opportunities and simulations" },
      { code: "W23", title: "Recurring suggestions and schedules" },
      { code: "W24", title: "Payment calendar and recording payments" },
      { code: "W25", title: "Spending impact and AI item review" },
      { code: "W26", title: "Recovery target, daily goals and checkpoints" },
      { code: "W27", title: "Recovery scenarios and saved plans" },
      { code: "W28", title: "Month-end review" },
    ],
  },
  {
    title: "Account and help",
    videos: [
      { code: "W29", title: "Notifications and recovery alert preferences" },
      { code: "W30", title: "Ask FinSight, conversations and feedback" },
      { code: "W31", title: "Profile, security, sign-out and account deletion" },
      { code: "W32", title: "Appearance, guidance, help and recovery states" },
    ],
  },
];

/** Privacy-enhanced embed: no YouTube cookies until the viewer presses play. */
export const youtubeEmbedUrl = (id: string) =>
  `https://www.youtube-nocookie.com/embed/${encodeURIComponent(id)}?autoplay=1&rel=0&modestbranding=1`;
