import { formatTableList, parseTableList } from '../lib/tables.js';

// Chống quên đơn đặt bàn (chạy mỗi phút):
// 1. 30′ trước giờ đặt: báo cả ca (ai đang chấm công + quản lý).
// 2. 20′ trước giờ đặt mà bàn đã đặt vẫn có khách: tự chuyển đơn sang bàn trống phù hợp và báo;
//    hết bàn thì báo gấp quản lý.
// 3. Quá giờ giữ bàn (15′) khách chưa đến: nhắc gọi khách hoặc bấm "Không đến".
// 4. Đầu ca chiều (mặc định 16:00): gửi tóm tắt các bàn đặt hôm nay.
export default function (r, ctx) {
  const { db } = ctx;
  const addCol = (c, d) => { if (!db.prepare('PRAGMA table_info(reservations)').all().some((x) => x.name === c)) db.exec(`ALTER TABLE reservations ADD COLUMN ${c} ${d}`); };
  addCol('pre_notified_at', 'INTEGER');
  addCol('moved_check_at', 'INTEGER');
  addCol('late_notified_at', 'INTEGER');

  const hm = (m) => `${String(Math.floor(m / 60) % 24).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
  const managers = () => db.prepare("SELECT id FROM staff WHERE active = 1 AND role IN ('owner','manager','shift_lead')").all().map((s) => s.id);
  const team = (date) => [...new Set([
    ...db.prepare('SELECT DISTINCT staff_id AS id FROM attendance WHERE date = ? AND clock_out IS NULL').all(date).map((x) => x.id),
    ...managers(),
  ])];
  const busyNow = () => new Set(db.prepare("SELECT t.table_number FROM session_tables t JOIN table_sessions s ON s.id = t.session_id WHERE s.status IN ('open','paying')").all().map((x) => x.table_number));

  // Bàn trống thay thế: ưu tiên 1 bàn đủ chỗ cùng khu, không thì ghép các bàn liền số trong 1 khu
  function pickTables(rv) {
    const free = ctx.freeTablesNow(rv.duration_min || 85, rv.id);
    const old = parseTableList(rv.tables);
    const zone = rv.zone_id || db.prepare('SELECT zone_id FROM dining_tables WHERE number = ?').get(old[0])?.zone_id;
    const near = (a, b) => Number(b.zone_id === zone) - Number(a.zone_id === zone) || (a.seats - b.seats) || Math.abs(a.number - old[0]) - Math.abs(b.number - old[0]);
    const single = free.filter((t) => t.seats >= rv.guests).sort(near)[0];
    if (single) return [single.number];
    const byZone = new Map();
    for (const t of free) byZone.set(t.zone_id, [...(byZone.get(t.zone_id) || []), t]);
    const zones = [...byZone.keys()].sort((a, b) => Number(b === zone) - Number(a === zone));
    for (const z of zones) {
      const list = byZone.get(z);
      for (let i = 0; i < list.length; i++) {
        let seats = 0;
        const run = [];
        for (let j = i; j < list.length && (j === i || list[j].number === list[j - 1].number + 1); j++) {
          run.push(list[j].number);
          seats += list[j].seats;
          if (seats >= rv.guests) return run;
        }
      }
    }
    return null;
  }

  ctx.bookingGuardTick = () => {
    const now = ctx.now();
    const clock = ctx.clock();
    const today = clock.businessDate(now);
    const hold = Number(ctx.setting('reserve_hold_minutes') || 15);
    let n = 0;
    const rows = db.prepare("SELECT * FROM reservations WHERE date = ? AND kind = 'booking' AND status = 'booked' ORDER BY time_min").all(today);
    for (const rv of rows) {
      const mins = (clock.toEpoch(today, rv.time_min) - now) / 60_000;
      const who = `${rv.name} · ${rv.guests} khách · ${hm(rv.time_min)}`;
      if (mins > 0 && mins <= 30 && !rv.pre_notified_at) {
        ctx.notify(team(today), { title: `30′ nữa có khách đặt: ${rv.name}`, body: `${rv.guests} khách · ${hm(rv.time_min)} · bàn ${rv.tables || 'chưa xếp'}${rv.note ? ` · ${rv.note}` : ''}`, link: `/dat-ban?date=${today}` });
        db.prepare('UPDATE reservations SET pre_notified_at = ? WHERE id = ?').run(now, rv.id);
        n++;
      }
      if (mins <= 20 && mins > -hold && !rv.moved_check_at && rv.tables) {
        const busy = busyNow();
        const stuck = parseTableList(rv.tables).filter((t) => busy.has(t));
        if (stuck.length) {
          const alt = pickTables(rv);
          if (alt) {
            const to = formatTableList(alt);
            db.prepare('UPDATE reservations SET tables = ?, moved_check_at = ? WHERE id = ?').run(to, now, rv.id);
            ctx.audit(null, 'reservation.auto_move', { id: rv.id, from: rv.tables, to });
            ctx.notify(team(today), { title: `Đã chuyển bàn đặt: ${rv.name} → bàn ${to}`, body: `Bàn ${stuck.join(', ')} còn khách. ${who}. Dọn sẵn bàn ${to}.`, link: `/dat-ban?date=${today}`, urgent: true });
          } else {
            db.prepare('UPDATE reservations SET moved_check_at = ? WHERE id = ?').run(now, rv.id);
            ctx.notify(managers(), { title: `GẤP: bàn đặt của ${rv.name} còn khách, hết bàn trống`, body: `${who} · bàn ${rv.tables}. Hối bàn đang ngồi tính tiền, hoặc gọi khách ${rv.phone || ''} báo chờ.`, link: '/so-do', urgent: true });
          }
          ctx.broadcast?.('reservations');
          n++;
        }
      }
      if (mins <= -hold && !rv.late_notified_at) {
        ctx.notify(team(today), { title: `Khách đặt trễ ${hold}′: ${rv.name}`, body: `${who}${rv.phone ? ` · gọi ${rv.phone}` : ''}. Khách không đến thì bấm "Không đến" để mở bàn.`, link: `/dat-ban?date=${today}`, urgent: true });
        db.prepare('UPDATE reservations SET late_notified_at = ? WHERE id = ?').run(now, rv.id);
        n++;
      }
    }
    // Tóm tắt đầu ca
    const [h, m] = String(ctx.setting('booking_brief_time') || '16:00').split(':').map(Number);
    if (clock.dateOf(now) === today && clock.minuteOf(now) >= h * 60 + m && ctx.setting('booking_brief_date') !== today) {
      ctx.setSetting('booking_brief_date', today);
      const list = rows.filter((x) => clock.toEpoch(today, x.time_min) > now);
      if (list.length) {
        const guests = list.reduce((s, x) => s + x.guests, 0);
        ctx.notify(team(today), {
          title: `Hôm nay ${list.length} bàn đặt · ${guests} khách`,
          body: list.map((x) => `${hm(x.time_min)} ${x.name} ${x.guests}k bàn ${x.tables || '?'}`).join('\n'),
          link: `/dat-ban?date=${today}`,
        });
        n++;
      }
    }
    return n;
  };
}
