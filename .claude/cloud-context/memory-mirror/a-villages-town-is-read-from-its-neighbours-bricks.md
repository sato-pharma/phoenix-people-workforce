---
name: a-villages-town-is-read-from-its-neighbours-bricks
description: "When a customer's address names a village with no brick of its own, the town is read by counting which brick the OTHER active map rows containing that village name sit in — 22 of 24 for بنى حميل and 13 of 17 for الشيخ مرزوق pointed at البلينا, while الجرجاوية turned out to be a street inside مدينة سوهاج (18 of 21), so the plural evidence keeps a city customer in the city instead of moving it on the name."
metadata:
  node_type: memory
  type: project
---

The brick table holds **towns**, not villages, so an address like `بنى حميل بجوار مدرسة السلام` or
`الشيخ مرزوق` names nothing in `source_of_sales_bricks`. The reliable reading is the neighbours':

```sql
select b.brick_name, m.brick_id, m.area_code, count(*)
from public.source_of_sales_customer_map m
left join public.source_of_sales_bricks b on b.brick_id = m.brick_id
where m.active = true and m.address like '%<the village>%'
group by 1,2,3 order by 4 desc;
```

Measured 2026-10-09 on the ten customers his 2026-08-10 city-vs-markaz ruling had kept on
`B213-1 مدينة سوهاج`:

| Needle | Dominant brick | Count | Read as |
| --- | --- | --- | --- |
| `بنى حميل` / `بني حميل` | البلينا `B214-M1` | 22 of 24 | البلينا |
| `الشيخ مرزوق` | البلينا `B214-M1` | 13 of 17 | البلينا, and it also decoded a BLINA address truncated to `…مجلس المدينة البل` |
| `دارالسلام` / `دار السلام` (Sohag spellings) | **دار السلام -سوهاج `B166-1`**, area UE6 | 95 | a Sohag 2 town with its own brick — easy to miss because a national `دار السلام` brick `B35-M1` exists in Giza |
| `الجرجاوية` | مدينة سوهاج `B213-1` | 18 of 21 | **a STREET inside the city** — the name only looks like جرجا |
| `المساعيد` | جرجا 8 · العسيرات 4 | split | not decidable — ask him |
| `ميدان الشهداء` | city 2 · دار السلام 2 · جهينه 2 · جرجا 2 | no signal | not decidable — ask him |

🔴 **The method's real value is the NEGATIVE answer.** اسعد الكبري carries 2,974.73 EGP of September
CNS and its address reads `ش الجرجاوية الشرقي`; moving it on the name would have handed the biggest
single sum in the cohort to the wrong rep, and the neighbour count is what refused it. Check the
distributor's own `area_name` on the import rows as a second opinion — it agreed on البلينا and
دار السلام, and it is self-contradictory (`Sohag1 | Sohag2`) on exactly the ambiguous ones.

See [[his-sohag-ruling-of-2026-10-09-moves-eight-customers]] for the ruling these ten belong to and
[[ask-business-questions-as-in-chat-multiple-choice]] for what to do with the two that stayed split.
