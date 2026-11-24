/**
 * The app's icon set — Lucide, so every glyph shares one drawn grid instead
 * of the hand-plotted paths used before. Names stay stable so call sites
 * never import Lucide directly for shell icons.
 *
 * Colour and size come from the call site (`currentColor`, className).
 * Lucide marks icons `aria-hidden` when no label is passed; every usage sits
 * beside a text label, so announcing them would just double up.
 */
import {
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  Banknote,
  Bell,
  Building2,
  CalendarDays,
  Camera,
  ChartLine,
  Check,
  ChevronDown,
  ChevronLeft,
  CircleHelp,
  CircleUser,
  Contrast,
  Copy,
  Crop,
  Eye,
  EyeOff,
  FileSpreadsheet,
  FileText,
  LayoutDashboard,
  LogOut,
  Moon,
  PanelLeft,
  Pencil,
  Plus,
  Search,
  Settings,
  ShoppingBag,
  Sparkles,
  Sun,
  Tag,
  Trash2,
  TriangleAlert,
  Upload,
  type LucideIcon,
} from "lucide-react";

type IconProps = { className?: string };

function wrap(Icon: LucideIcon) {
  return function FinSightIcon({ className = "h-5 w-5" }: IconProps) {
    return <Icon aria-hidden className={className} strokeWidth={1.75} />;
  };
}

export const IconDashboard = wrap(LayoutDashboard);
export const IconRecords = wrap(FileText);
export const IconInsights = wrap(ChartLine);
export const IconBusiness = wrap(Building2);
export const IconProfile = wrap(CircleUser);
export const IconLogout = wrap(LogOut);
export const IconPlus = wrap(Plus);
export const IconChevronDown = wrap(ChevronDown);
export const IconExpense = wrap(Banknote);
export const IconSales = wrap(ShoppingBag);
export const IconCamera = wrap(Camera);
export const IconCrop = wrap(Crop);
export const IconUpload = wrap(Upload);
export const IconCsvFile = wrap(FileSpreadsheet);
export const IconSearch = wrap(Search);
export const IconEdit = wrap(Pencil);
export const IconTrash = wrap(Trash2);
export const IconDuplicate = wrap(Copy);
export const IconCheck = wrap(Check);
export const IconAlertTriangle = wrap(TriangleAlert);
export const IconSparkle = wrap(Sparkles);
export const IconArrowRight = wrap(ArrowRight);
export const IconArrowUp = wrap(ArrowUp);
export const IconArrowLeft = wrap(ArrowLeft);
export const IconChevronLeft = wrap(ChevronLeft);
export const IconBell = wrap(Bell);
export const IconCalendar = wrap(CalendarDays);
/** The sidebar collapse control. */
export const IconSidebar = wrap(PanelLeft);
export const IconSun = wrap(Sun);
export const IconMoon = wrap(Moon);
/** Half-filled circle — the "Classic" theme's mark, and the switcher's icon. */
export const IconTheme = wrap(Contrast);
export const IconSettings = wrap(Settings);
export const IconHelp = wrap(CircleHelp);
/** Expense categories. */
export const IconTag = wrap(Tag);
export const IconEye = wrap(Eye);
export const IconEyeOff = wrap(EyeOff);
