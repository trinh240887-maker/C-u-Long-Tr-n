// Dòng khuyến mãi trên phiếu bếp (dùng chung cho máy in và màn bếp):
// "2 x Combo 3" có 1 phần tặng → "KM Mua 1 tặng 1 steak → 2 phần: 1 tính tiền + 1 TẶNG" để bếp không làm dư / thiếu
export const promoLine = (l) => `KM ${l.promo}${!l.free ? '' : l.free >= l.qty ? ' → PHẦN TẶNG' : ` → ${l.qty} phần: ${l.qty - l.free} tính tiền + ${l.free} TẶNG`}`;
