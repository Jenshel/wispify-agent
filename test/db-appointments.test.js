'use strict';
// RED->GREEN for src/db/appointments.js (tasks.md Phase 8) — the minimal
// appointments table this phase needs for the double-booking guard's
// conflict query (8.1/8.2) and the reminder job's upcoming-appointment scan
// (8.4). See schema.sql's own comment for why this is a dedicated table
// rather than a reuse of Phase 9's general-purpose `orders` table.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const { openDatabase } = require('../src/db');
const appointments = require('../src/db/appointments');

function freshDb() {
  return openDatabase(':memory:');
}

function makeAppt(overrides = {}) {
  return {
    id: crypto.randomUUID(),
    customerPhone: '5215500000001',
    service: 'Corte',
    date: '2030-01-15',
    time: '15:00',
    durationMinutes: 30,
    paymentMethod: 'cash',
    total: 200,
    status: 'confirmed',
    googleEventId: null,
    meetLink: null,
    ...overrides,
  };
}

test('createAppointment() persists a row and returns it in camelCase', () => {
  const db = freshDb();
  const input = makeAppt();
  const created = appointments.createAppointment(db, input);
  assert.equal(created.id, input.id);
  assert.equal(created.customerPhone, input.customerPhone);
  assert.equal(created.service, 'Corte');
  assert.equal(created.date, '2030-01-15');
  assert.equal(created.time, '15:00');
  assert.equal(created.durationMinutes, 30);
  assert.equal(created.status, 'confirmed');
  assert.equal(created.reminder30Sent, false);
  assert.equal(created.reminder5Sent, false);
  assert.equal(created.noShowSent, false);
});

test('getAppointmentById() returns null for an unknown id', () => {
  const db = freshDb();
  assert.equal(appointments.getAppointmentById(db, 'nope'), null);
});

test('findConflict() finds an existing confirmed appointment at the same date+time for a DIFFERENT customer', () => {
  const db = freshDb();
  appointments.createAppointment(db, makeAppt({ customerPhone: '5215500000001' }));
  const conflict = appointments.findConflict(db, { date: '2030-01-15', time: '15:00', excludePhone: '5215500009999' });
  assert.ok(conflict);
  assert.equal(conflict.customerPhone, '5215500000001');
});

test('findConflict() excludes the SAME customer\'s own prior booking (a reschedule is not a conflict with yourself)', () => {
  const db = freshDb();
  appointments.createAppointment(db, makeAppt({ customerPhone: '5215500000001' }));
  const conflict = appointments.findConflict(db, { date: '2030-01-15', time: '15:00', excludePhone: '5215500000001' });
  assert.equal(conflict, null);
});

test('findConflict() ignores cancelled appointments', () => {
  const db = freshDb();
  const appt = appointments.createAppointment(db, makeAppt({ customerPhone: '5215500000001', status: 'cancelled' }));
  assert.equal(appt.status, 'cancelled');
  const conflict = appointments.findConflict(db, { date: '2030-01-15', time: '15:00', excludePhone: '5215500009999' });
  assert.equal(conflict, null);
});

test('findConflict() returns null when date or time differs', () => {
  const db = freshDb();
  appointments.createAppointment(db, makeAppt({ date: '2030-01-15', time: '15:00' }));
  assert.equal(appointments.findConflict(db, { date: '2030-01-16', time: '15:00', excludePhone: 'x' }), null);
  assert.equal(appointments.findConflict(db, { date: '2030-01-15', time: '16:00', excludePhone: 'x' }), null);
});

test('setGoogleEvent() attaches the Calendar event id + Meet link', () => {
  const db = freshDb();
  const appt = appointments.createAppointment(db, makeAppt());
  const updated = appointments.setGoogleEvent(db, appt.id, { googleEventId: 'evt_123', meetLink: 'https://meet.google.com/abc' });
  assert.equal(updated.googleEventId, 'evt_123');
  assert.equal(updated.meetLink, 'https://meet.google.com/abc');
});

test('listActiveAppointments() returns only confirmed appointments', () => {
  const db = freshDb();
  appointments.createAppointment(db, makeAppt({ status: 'confirmed' }));
  appointments.createAppointment(db, makeAppt({ status: 'cancelled' }));
  const active = appointments.listActiveAppointments(db);
  assert.equal(active.length, 1);
  assert.equal(active[0].status, 'confirmed');
});

test('markReminderSent() flips the correct reminder flag without touching the others', () => {
  const db = freshDb();
  const appt = appointments.createAppointment(db, makeAppt());
  appointments.markReminderSent(db, appt.id, 'reminder30');
  let row = appointments.getAppointmentById(db, appt.id);
  assert.equal(row.reminder30Sent, true);
  assert.equal(row.reminder5Sent, false);

  appointments.markReminderSent(db, appt.id, 'reminder5');
  row = appointments.getAppointmentById(db, appt.id);
  assert.equal(row.reminder5Sent, true);
  assert.equal(row.noShowSent, false);

  appointments.markReminderSent(db, appt.id, 'noShow');
  row = appointments.getAppointmentById(db, appt.id);
  assert.equal(row.noShowSent, true);
});

test('markReminderSent() throws on an unknown field rather than silently no-op-ing', () => {
  const db = freshDb();
  const appt = appointments.createAppointment(db, makeAppt());
  assert.throws(() => appointments.markReminderSent(db, appt.id, 'bogus'));
});
