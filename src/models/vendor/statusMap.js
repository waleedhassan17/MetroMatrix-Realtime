/**
 * Canonical Home-Services booking lifecycle and its display mappings.
 *
 * WHY THIS FILE EXISTS: the frontend grew four different status vocabularies
 * (models/serviceProviders/booking.ts, serviceStatus.ts, tracking.ts, job.ts +
 * dashboard.ts) before any backend existed. The backend stores ONE canonical
 * status; every screen-facing shape is derived here — and only here — so the
 * vocabularies can never drift apart again. See HOMESERVICE_SPEC.md §2 in the
 * frontend repo.
 */

const STATUS = {
  PENDING: 'PENDING',
  ACCEPTED: 'ACCEPTED',
  REJECTED: 'REJECTED',
  CANCELLED: 'CANCELLED',
  EN_ROUTE: 'EN_ROUTE',
  ARRIVED: 'ARRIVED',
  IN_PROGRESS: 'IN_PROGRESS',
  COMPLETED: 'COMPLETED',
};

const ALL_STATUSES = Object.values(STATUS);

const TERMINAL_STATUSES = [STATUS.COMPLETED, STATUS.REJECTED, STATUS.CANCELLED];

const ALLOWED_TRANSITIONS = {
  [STATUS.PENDING]: [STATUS.ACCEPTED, STATUS.REJECTED, STATUS.CANCELLED],
  [STATUS.ACCEPTED]: [STATUS.EN_ROUTE, STATUS.CANCELLED],
  [STATUS.EN_ROUTE]: [STATUS.ARRIVED, STATUS.CANCELLED],
  [STATUS.ARRIVED]: [STATUS.IN_PROGRESS, STATUS.CANCELLED],
  [STATUS.IN_PROGRESS]: [STATUS.COMPLETED],
  [STATUS.COMPLETED]: [],
  [STATUS.REJECTED]: [],
  [STATUS.CANCELLED]: [],
};

// Transitions only the assigned provider may perform
const PROVIDER_TRANSITIONS = [
  STATUS.ACCEPTED,
  STATUS.REJECTED,
  STATUS.EN_ROUTE,
  STATUS.ARRIVED,
  STATUS.IN_PROGRESS,
  STATUS.COMPLETED,
];

// → booking.ts / UserBooking ('pending'|'confirmed'|'in_progress'|'completed'|'cancelled')
function toBookingStatus(status) {
  switch (status) {
    case STATUS.PENDING:
      return 'pending';
    case STATUS.ACCEPTED:
    case STATUS.EN_ROUTE:
    case STATUS.ARRIVED:
      return 'confirmed';
    case STATUS.IN_PROGRESS:
      return 'in_progress';
    case STATUS.COMPLETED:
      return 'completed';
    default:
      return 'cancelled'; // REJECTED + CANCELLED
  }
}

// → BookingConfirmation.status ('waiting'|'confirmed'|'rejected'|'cancelled')
function toConfirmationStatus(status) {
  switch (status) {
    case STATUS.PENDING:
      return 'waiting';
    case STATUS.REJECTED:
      return 'rejected';
    case STATUS.CANCELLED:
      return 'cancelled';
    default:
      return 'confirmed';
  }
}

// → serviceStatus.ts ('arrived'|'in_progress'|'completed')
function toServiceStatus(status) {
  switch (status) {
    case STATUS.IN_PROGRESS:
      return 'in_progress';
    case STATUS.COMPLETED:
      return 'completed';
    default:
      return 'arrived'; // screen is only reachable from ARRIVED onwards
  }
}

// → tracking.ts ('en_route'|'nearby'|'arrived'|'in_progress'|'completed')
function toTrackingStatus(status, distanceMeters = null) {
  switch (status) {
    case STATUS.EN_ROUTE:
      return distanceMeters !== null && distanceMeters < 500 ? 'nearby' : 'en_route';
    case STATUS.ARRIVED:
      return 'arrived';
    case STATUS.IN_PROGRESS:
      return 'in_progress';
    case STATUS.COMPLETED:
      return 'completed';
    default:
      return 'en_route';
  }
}

/**
 * → job.ts display buckets ('available'|'today'|'upcoming'|'active'|'completed'|'cancelled').
 * Buckets are computed per request from status + schedule; they are filters,
 * never stored.
 */
function toJobBucket(status, scheduledFor, now = new Date()) {
  switch (status) {
    case STATUS.PENDING:
      return 'available';
    case STATUS.ACCEPTED: {
      const d = scheduledFor ? new Date(scheduledFor) : now;
      const sameDay =
        d.getFullYear() === now.getFullYear() &&
        d.getMonth() === now.getMonth() &&
        d.getDate() === now.getDate();
      return sameDay ? 'today' : 'upcoming';
    }
    case STATUS.EN_ROUTE:
    case STATUS.ARRIVED:
    case STATUS.IN_PROGRESS:
      return 'active';
    case STATUS.COMPLETED:
      return 'completed';
    default:
      return 'cancelled';
  }
}

// → dashboard.ts DashboardJob.status ('pending'|'accepted'|'in_progress'|'completed')
function toDashboardStatus(status) {
  switch (status) {
    case STATUS.PENDING:
      return 'pending';
    case STATUS.ACCEPTED:
    case STATUS.EN_ROUTE:
    case STATUS.ARRIVED:
      return 'accepted';
    case STATUS.IN_PROGRESS:
      return 'in_progress';
    default:
      return 'completed';
  }
}

module.exports = {
  STATUS,
  ALL_STATUSES,
  TERMINAL_STATUSES,
  ALLOWED_TRANSITIONS,
  PROVIDER_TRANSITIONS,
  toBookingStatus,
  toConfirmationStatus,
  toServiceStatus,
  toTrackingStatus,
  toJobBucket,
  toDashboardStatus,
};
