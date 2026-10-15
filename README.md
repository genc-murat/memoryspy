# MemorySpy

Çalışan bir .NET sürecinin belleğini canlı olarak izleyen, **sorunun nerede olduğunu söyleyen**
masaüstü uygulaması. Tauri (Rust + React) ile yazıldı; veriyi EventPipe üzerinden .NET
tarafındaki bir yardımcı süreç toplar.

`dotnet-counters monitor -n <proc> --counters System.Runtime[working-set,gc-heap-size,...]`
komutunun verdiği sayıları gösterir, ama dört şeyi ekler:

1. **Hangi sınıf büyüyor?** — runtime'ın örneklediği ayırma olaylarından (`GC/AllocationTick`, ya
   da yakalama açıkken `AllocationSampling`) tür bazında ayırma hızı çıkarılır, liste hâlinde ve
   zaman içinde artışıyla gösterilir.
2. **Sayılar ne anlama geliyor?** — trend analizi (lineer regresyon + r²), eşikler ve
   "şimdi ne yapmalı" adımları ile birlikte bulgular hâlinde sunulur.
3. **Nereye bakmalı?** — Gen 2'de birikme, LOH büyümesi, GC handle sızıntısı, thread pool
   açlığı gibi durumlar ayrı ayrı tanınır ve birbirinden ayrılır.
4. **Neyin hayatta kaldığı ve onu kimin tuttuğu?** — istendiğinde runtime'ın gerçek nesne
   grafiği yürünür (heap snapshot): tür başına canlı nesne sayısı ve bayt, her tür için
   **"silinirse boşalan"** bayt miktarı (türün tuttuğu alan, kapladığı alan değil), ve en
   büyük türler için **bir GC kökünden canlı bir örneğe giden referans zinciri** — her halkası
   kendi tuttuğu alanla birlikte. Böylece "bu tür büyük" ile "bu tür *şundan dolayı* büyük"
   birbirinden ayrılır; zincirin tepesindeki referans kesilmesi gereken referanstır.

Kısa yol: uygulamayı aç, soldan süreci seç, "attached" ol. Sağdaki **Managed heap** şeridi
her zaman açık kalır; üstteki büyük sayı ise asıl sorunun cevabıdır: **dakikada kaç MB
büyüyor**.

---

## Hızlı başlangıç

Gereksinimler: .NET SDK 10+ (`dotnet --version`), Node 20+, Rust toolchain, macOS'ta Xcode
Command Line Tools. Bunlar kaynaktan derlemek için; kurulan uygulamada collector
self-contained publish edilir ve .NET runtime'ı installer'ın içinde taşındığı için hedef
makinede `dotnet` gerekmez.

```bash
npm install
npm run prepare:all      # collector + örnek uygulamayı derler
npm run app:dev          # masaüstü uygulamayı açar
```

Denemek için sahte bir sızıntı üreten örnek servisi ayrı bir terminalde başlat:

```bash
npm run sample:run -- cache        # sınırsız büyüyen Dictionary (klasik managed leak)
npm run sample:run -- loh          # büyük byte[] birikimi (LOH + fragmentasyon)
npm run sample:run -- strings      # sınırsız string birikimi
npm run sample:run -- churn        # sızıntı yok, sadece yüksek ayırma hızı
npm run sample:run -- handles      # pinlenmiş buffer + hiç çıkarılmayan event handler
npm run sample:run -- all          # hepsi birden
```

Sonra uygulamada `MemorySpy.Samples.LeakyCache` sürecine bağlan. `cache` modunda
`SessionRecord` tipi birkaç saniye içinde "Top suspect" olarak görünmelidir.

Aynı sızıntının **tutulma zinciri** için `Heap Snapshot` sekmesinden bir yürüyüş başlat
(düğme; hedef bir Gen 2 collection boyunca duraklar). Örnekte çıkan cevap şudur — zincirin
en üstündeki referans kesilmesi gereken referanstır:

```
static System.Threading.TimerQueue[].<Instance>          (runCache async durum makinesi)
  → System.Threading.TimerQueue → TimerQueueTimer → DelayPromiseWithCancellation
  → ContinueWithTaskContinuation → ContinuationTaskFromTask
  → AsyncStateMachineBox`1[VoidTaskResult] → <<Main>$>g__RunCache|0_7>d
  → Dictionary`2[System.Guid, SessionRecord]       80 B
  → Entry[System.Guid, SessionRecord][]            92 MB   (4,3 M kaydı tek nesnede tutan dizi)
  → SessionRecord                                  56 B
  → System.Byte[]                                 280 B
```

Zincir, sızan sözlüğü tutan şeyin *async devam (continuation) durum makinesi* olduğunu — ve
onun da thread pool zamanlayıcı kuyruğundan köklendiğini — gösterir. Yani sorun sözlüğün
kendisi değil, onu yaşatan `Task.Delay(...).ContinueWith(...)` örüntüsüdür.

### Derleme

```bash
npm run collector:publish    # collector'ı src-tauri/resources/collector altına yayınlar (önce bu)
npm run app:build            # .app ve .dmg üretir
```

Sırası önemli: `collector:publish` çalıştırılmazsa paket collector'sız çıkar ve uygulama
kurulduğu makinede "Collector not found" der (kaynak ağacında çalışırken sorun olmaz,
çünkü host derleme çıktısını da arar).

Kurulmuş bir paketin sağlığını kontrol etmek için:

```bash
MemorySpy.app/Contents/MacOS/memoryspy --check
```

Bu, pencere açmadan collector keşfini, sürümleri ve yetenekleri JSON olarak basar;
collector bulunamazsa çıkış kodu 3 olur. Bu çıktı bir hata bildirimine olduğu gibi
yapıştırılabilir.

---

## Uygulama içi görünümler

| Sekme | Ne gösterir |
| --- | --- |
| **Overview** | Heap büyüme hızı (hero), çalışma seti / GC heap / nesil grafikleri, ayırma ve GC maliyeti, tüm sayaçlar |
| **Types** | Tür bazında ayırma hızı, payı, trend sparkline'ı, ortalama nesne boyutu, toplam; en olası şüpheli |
| **Call Sites** | Belleği **hangi metot** ayırıyor: çağrı yeri bazında pay, örneklenen hacim, hâkim tip, açılan çağrı zinciri; aynı verinin tip tarafından görünümü |
| **GC & Heap** | Nesil bazında heap kompozisyonu, tek tek collection kayıtları (gerçek duraklama süreleri), collection sebepleri |
| **Heap Snapshot** | İstek üzerine canlı heap yürüyüşü: tür başına canlı nesne/bayt ve "silinirse boşalan" bayt, GC köklerinden canlı örneklere giden referans zincirleri ("bunu kim tutuyor?", halka başına tutulan alan), hedefin duraklama maliyeti |
| **Diagnosis** | Bulgular: önem derecesi, kanıt sayıları ve yapılacaklar listesi |
| **Diagnostics** | Collector stderr'i, oturum istatistikleri, sayıları sıfırlama |
| **Recordings** | Diskteki kayıtlar ve bunları çevrimdışı replay etme; başka makineden gelen dosyayı açma |
| **Settings** | Collector yolu, örnekleme varsayılanları, collector'ın bildirdiği yetenekler |

Verinin şeklini (büyüyor mu, hangi nesilde) sağ kenardaki **heap spine** gösterir.

---

## Kod bloğunu bulmak: derin yakalama

`Types` sekmesi bir **tip adı** verir. Tip senin sınıfınsa bu yeterlidir; ama ayırmanın
çoğunluğu framework tipleridir — `System.Byte[]`, `System.String`, bir `Dictionary`'nin iç
dizisi — ve orada `new byte[]` aramasıyla bir yere varılmaz. `Call Sites` sekmesi tam bu
durum için var: tip adı yerine **çağrı yerini** verir.

**Nasıl çalıştırılır:** sol rayda `Deep capture → Resolve allocation call sites` kutusunu
işaretle, sonra bağlan. Sızıntıyı gördükten sonra değil — yakalama, oturum başlamadan önce
silahlanmalıdır. Hedefi bir süre çalıştır, sonra **Detach**: analiz saniyeler içinde
görünür.

| | Ne olur |
| --- | --- |
| Bağlanırken | Ham EventPipe akışı kayıt klasörüne `capture-<pid>-<zaman>.nettrace` olarak kopyalanır |
| Çalışırken | Diğer sekmeler normal çalışır; `Call Sites` "henüz yok" der ve yakalamanın nereye yazıldığını gösterir. `Types` çalışmaya devam eder ama sayıları **örnekleme temeline** geçer: runtime bu oturumda tik yerine nesne başına örnek yayar, panel bunu kendi cümlesiyle söyler |
| Detach edince | Capture ETLX'e çevrilir, metot adları çözülür, PDB'ler okunup **dosya:satır** bulunur, çağrı yerleri sıralanır; ara ETLX dosyası silinir, `.nettrace` kalır |
| Replay'de | Çağrı yerleri kaydın içindedir, yani dosyayı başka bir makinede açtığında da görünür |

`By call site` görünümü "hangi **satır** ne kadar ayırdı" sorusunu, `By type` görünümü "bu tip
nereden geliyor" sorusunu yanıtlar. Satıra tıklayınca çağrı zincirini (her frame kendi
satırıyla) ve o kodun ayırdığı tipleri gösterir.

**Satır nasıl bulunuyor, bulunamazsa ne oluyor.** Runtime'ın yığını metodu ve IL offsetini
verir; offseti satıra çeviren tek şey modülün **PDB**'sidir. PDB'ler assembly'nin yanında
aranır, `_NT_SYMBOL_PATH` ayarlıysa oradaki sunuculara da sorulur (ayarlı değilse hiçbir ağ
çağrısı yapılmaz). Sunucuya bağlı aramalar **5 saniyelik bir bütçeyle** sınırlıdır ve bütçe
dolduğunda artık sunucuya sorulmaz; assembly'nin yanındaki PDB'ler bu bütçeden muaftır, çünkü
onlar diskten mikrosaniyelerde cevap verir ve bir sunucu isteği yüzünden **kendi kodunun
satırını** kaybetmemelidir. Bütçe tek bir isteği kesemez: kara delik bir sembol sunucusuna karşı
ölçümde tam olarak bu oldu — bir istek 62 saniye boyunca cevap vermedi, koşu 62 saniye sürdü,
ama `Program.cs:86` ve `Program.cs:89` yine de çözüldü; yalnızca sunucuya ihtiyaç duyan runtime
frame'leri metot adında kaldı ve bunun sebebi hem log'da hem arayüzde (`symbolStopReason`)
"bütçe dolduğu anda 62 saniye geçmişti, çünkü bir istek hiç cevaplanmadı" diye yazıyor.
PDB okunamayan modüllerde — genelde runtime'ın kendi assembly'leri —
satır yerine **metot adı** gösterilir ve bu gizlenmez: satırda `no PDB` etiketi çıkar, analiz
hangi modüllerin PDB'sinin bulunamadığını isimleriyle söyler. Yani aynı metot içindeki iki
ayrı `new` ifadesi PDB varsa iki ayrı satır olur; PDB yoksa ikisi tek satırda (metot adında)
birleşir.

Gerçek bir ölçüm (sızdıran örneğe karşı, 771 KB capture): çağrı yerleri `Program.cs:86` gibi
çıktı, aynı metottaki ikinci ayırma `Program.cs:89` olarak ayrı satır oldu, 44 ms dönüşüm +
99 ms analiz ve bunun yalnızca 5 ms'i PDB okumasıydı (sembol yolu ayarlı değilken ağa hiç
çıkılmaz). Daha büyük bir capture'da (26 MB,
`all` modu): 390.324 örneklenmiş ayırma, 0,5 sn dönüşüm + 1,4 sn analiz. Çıktının en üstünde
`System.Byte[]` ayıran satır vardı — tip listesinin asla söyleyemeyeceği şey.

---

## Oturum kaydı ve çevrimdışı replay

Bir oturumu diske yazıp sonra hiçbir sürece bağlanmadan tekrar oynatabilirsin. Pratikte
anlamı şu: sızıntı **başka bir makinede** oldu ve artık o süreç yok — elinde kalan tek şey
dosya.

**Kayıt almak:** sol rayda `Recording → Write session to disk` kutusunu işaretle ve bağlan.
Kutuyu bağlıyken de işaretleyebilirsin: sızıntıyı gördükten sonra karar vermek en sık
senaryo, bu yüzden kayıt oturum ortasında başlar (dosya başlığı bunu `startedMidSession`
olarak işaretler). Kayıt durunca dosya kapanır ve `Recordings` sekmesinde görünür.

**Replay:** `Recordings` sekmesinde bir kaydın yanındaki **Replay**'e bas. Üstte şerit
açılır:

| Kontrol | Ne yapar |
| --- | --- |
| Play / Pause | Duraklatır; duraklatılmışken hiç mesaj akmaz |
| Hız | 0.25× – 240×; dört saatlik bir oturum bir dakikada geçer |
| Zaman çizelgesi | İstenen ana atlar — replay **baştan hızlı ileri sararak** oraya gider, böylece grafikler gerçekten o anki durumu gösterir |
| Restart | Baştan oynatır |
| Close replay | Replay modundan çıkar |

Başka bir makineden gelen dosyayı `Recordings → Open a recording from elsewhere`
alanına yolunu yazarak açabilirsin; dosyadan başka hiçbir şey gerekmez.

**Biçim.** Dosya düz NDJSON: ilk satır başlık (hedef süreç, pid, runtime, seçenekler),
sonra her olay için bir satır, sonda oturum kapanırken yazılan bir footer. Yani
`wc -l`, `grep`, `jq` ile incelenebilir:

```sh
jq -r 'select(.kind=="header") | .target' memoryspy-*.jsonl
wc -l memoryspy-*.jsonl
```

**İki şeyi garanti ediyor:**

- **Aynı yol.** Replay, kayıtlı mesajları canlı bir oturumun kullandığı *aynı* kanaldan
  geçirir. Yani altı sekmenin, grafiklerin ve teşhis kurallarının tamamı çevrimdışı da
  aynı şekilde çalışır; ayrı bir "replay görünümü" yoktur.
- **Gerçek zaman çizelgesi.** Grafikler mesajın kendi zaman damgasını (`ts`) kullanır,
  arayüzün saati değil. 32× hızda oynatılan iki saatlik bir sızıntı yine "+50 MB/dk"
  gösterir — hız ne olursa olsun sayı doğrudur. Bu, aracın var oluş sebebi olan sayıdır.

**Dosyalar nerede:** `~/Library/Application Support/com.muratgenc.memoryspy/recordings/`
(macOS). Tam yolu terminalden `memoryspy --check` çıktısındaki `recordingsDir` alanından da
alabilirsin. Kayıt dosyaları üretim verisidir: hedef sürecin tip adlarını ve süreç
ayrıntılarını içerir.

---

## Diagnostik kuralları

`Diagnosis` sekmesi şu imzaları birbirinden ayırır. Her bulgu kanıtını da gösterir, böylece
aracın sonucuna katılmadığın yerde neye baktığını görebilirsin.

| Bulgu | Ne demek |
| --- | --- |
| **Çalışma seti hızla artıyor** | Dakikada 50 MB üzeri, lineer (r² > 0.55) artış → gerçek sızıntı |
| **Gen 2 birikiyor** | Uzun ömürlü nesneler artıyor, LOH sabit → koleksiyon/cache/event handler sızıntısı |
| **LOH büyüyor** | 85 KB üzeri nesneler birikiyor → büyük diziler, bufferlar, stringler |
| **Gen 2 büyük ama hiç toplanmıyor** | Full GC görülmedi; heap hâlâ bütçe içinde veya referanslar tutuluyor |
| **GC handle sızıntısı** | `GCHandle.Alloc` / pinleme serbest bırakılmıyor |
| **Pinlenmiş nesneler** | `fixed` yerine uzun ömürlü pinleme → fragmentasyon |
| **Ayırma yüksek ama sızıntı yok** | Heap sabit, sadece churn → maliyet GC CPU'su, bellek değil |
| **GC'de çok zaman geçiyor** | Time in GC > %20 → throughput düşer |
| **Thread pool kuyruğu/thread sayısı artıyor** | Bloklayan iş var; thread başına stack maliyeti de birikir |
| **Exception yoğunluğu** | Kontrol akışı olarak exception kullanımı |
| **Şüpheli tip** | Ayırma payı + artan hız + büyük nesne boyutu birleşimi |

Öncelik listesi (suspect ranking) "en çok ayıran" değil, **hızı artan + büyük nesneli +
paya sahip** olanı öne alır; çünkü sızıntıyı yapan kombinasyon budur.

---

## Mimari (özet)

Üç süreç var, çünkü üçünün de farklı bir işi ve farklı bir hata toleransı var:

```
┌─────────────────────┐   Tauri olayları   ┌──────────────────┐   NDJSON / stdin   ┌────────────────────┐   EventPipe   ┌──────────────┐
│ React arayüz        │ ◄───────────────── │ Rust host        │ ◄───────────────── │ MemorySpy.Collector │ ◄─────────── │ Hedef .NET   │
│ grafikler, analiz   │ ─────────────────► │ süreç yönetimi   │ ─────────────────► │ (.NET sidecar)      │ ────────────► │ süreç        │
└─────────────────────┘                    └──────────────────┘                    └────────────────────┘                └──────────────┘
```

- **Collector** (`collector/`) ayrı bir süreçtir: `DiagnosticsClient` + `TraceEvent`
  bağımlılıkları büyüktür, .NET runtime isterler ve bozuk bir trace'i ayrıştırırken
  çökerse masaüstü uygulamasını da düşürmemelidir.
- **Rust host** (`src-tauri/`) bir denetçidir: collector'ı bulur, başlatır, çıktısını
  gruplayarak arayüze aktarır, oturum yaşam döngüsünü ve ayarları yönetir. Protokol
  bilgisi `collector.rs` içinde toplanmıştır; bu katman "sayaç" veya "nesil" nedir bilmez.
- **Arayüz** (`src/`) çizim ve teşhis yapar. Hangi görünümün açık olacağını collector'ın
  `capabilities` el sıkışmasından öğrenir.

Detaylar: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

---

## Genişletme

Proje bilinçli olarak genişletilebilir kurgulandı: yeni bir teşhis yeteneği eklemek
**collector'da bir sınıf + arayüzde bir kayıt** demektir. Protokol, host ve uygulama
kabuğu değişmez.

- Yeni bir **probe** (ör. heap snapshot diff, thread dump, async-stack, HTTP metrikleri):
  [docs/EXTENDING.md](docs/EXTENDING.md). Ham akışa ihtiyaç duyan bir probe (çağrı yığını
  çözen her şey) için `IRawCaptureConsumer` uzantı noktası var; capture/analiz yaşam
  döngüsünü oturum yönetir.
- Yeni bir **sayaç** zaten kod değişikliği istemez: katalogda olmayan sayaçlar runtime'ın
  bildirdiği birimle otomatik akar.
- Yeni bir **panel**: `src/panels/registry.tsx` içine bir kayıt.

---

## Sınırlar ve bilinmesi gerekenler

Dürüst olmak gerekirse, bu sürümün yapamadıkları ve bilinçli tasarım kararları:

- **Ayırma verisi örneklenmiştir, ve iki farklı temelde gelebilir.** Yakalama kapalıyken
  runtime kabaca her 100 KB ayırmada bir `GC/AllocationTick` üretir; yani "System.Byte[]
  11 MB/s ayırdı" bir tahmindir, tam muhasebe değildir ve nadir ayıran türler listede hiç
  görünmeyebilir. Derin yakalama açıkken ise oturumun anahtar kelimeleri değiştiği için
  runtime bunun yerine **her örneklenen ayırma için** nesnenin kendi boyutunu taşıyan bir
  `AllocationSampling` olayı yayar (ölçüldü: aynı süreçte tik temelinde 758 tik, yakalama
  temelinde 776 örnek). Panel hangi temelde olduğunu kendisi yazar, çünkü paylar iki temelde
  de yansızdır ama hacimler aynı ölçekte değildir — yakalama açıkken görülen mutlak sayılar
  (örneğin 0,04 MB/s) aynı uygulamanın tik tabanlı sayısıyla (17,9 MB/s) karşılaştırılmaz,
  listenin kendi içindeki sıralama karşılaştırılır.
- **Ayırma ≠ tutulma.** `Types` sekmesi neyin *üretildiğini* söyler; sızıntı için neyin
  *hayatta kaldığı* önemlidir. Bu yüzden panelin yanında heap trendi durur ve "şüpheli"
  uyarısı ancak heap de büyürken yükselir.
- **"Kim tutuyor" cevabı bir yürüyüşe mal olur.** `Heap Snapshot` sekmesi tutulma zincirini
  runtime'ın kendi grafiğinden verir, ama bedeli gerçektir: yürüyüş bir Gen 2 collection
  sırasında yapıldığı için hedef duraklar (panel `pauseMs` olarak yazar) ve collector grafiği
  kendi belleğinde tutar. Bu yüzden periyodik bir örnek değil, basılan bir düğmedir.
- **Heap yürüyüşü EventPipe üzerinden gelir, ve tampon dolduğunda olay atılabilir.**
  `dotnet-gcdump`'ın kullandığı `EventPipeBufferingMode.Block` bu runtime'da erişilebilir
  değil (`UnsupportedCommandException`), bu yüzden snapshot oturumunun tamponu yükseltilir ve
  eksik kalma **ölçülür**: yürünen nesnelerin köklerden erişilebilme oranı ve sayılan baytın
  runtime'ın aynı collection için bildirdiği `TotalHeapSize` ile karşılaştırılması. Ölçüldü:
  35 GB'lık bir heap'te yürüyüş 1,7 GB ve 13 138 344 nesnenin 3 240'ını gördü — olayların
  %95'i düşmüştü. Böyle bir durumda panel tür toplamlarını bir **alt sınır** olarak sunar ve
  **tutulma zinciri hiç göstermez**: eksik referanslarla çizilen bir zincir tahmin olurdu.
- **İki farklı bayt sayısı yan yana durur; karıştırılmamalıdır.** `liveBytes` türün
  nesnelerinin kapladığı alandır; **"silinirse boşalan"** ise o türün bütün nesneleri
  kaldırıldığında artık erişilemeyen canlı baytlardır — yani türün *tuttuuğu* alan, *kapladığı*
  alan değil. Küçük bir tür büyük bir şeyi tutabildiği için bu sayı genelde daha büyüktür:
  örnekte `SessionRecord` 119,5 MB yer kaplar ama **825,6 MB**'lık alanı ayakta tutar; 92,6 MB'lık
  `Entry[]` dizisi ise **918,2 MB**'ı tutar. Ölçüm tahmin değildir: nesneler grafikten çıkarılıp
  graf yeniden yürünür, ama soru başına bir yürüyüş harcandığı için sayı yalnızca raporlanan
  türlere ve zincir halkalarına verilir, geri kalanı "—" kalır.
- **Derin yakalama canlı değildir.** Çağrı yığınları ancak tamamlanmış bir akıştan
  çözülebildiği için cevap Detach anında gelir; oturum sürerken bu sekme boştur. Ayrıca
  diske yazar (varsayılan üst sınır 256 MB; sınıra gelinirse yakalama kesilir ve bu açıkça
  bildirilir) ve oturuma method rundown eklediği için bağlanma bir tık yavaşlar. Bu yüzden
  varsayılan olarak kapalıdır.
- **Çağrı yeri verisi de örneklenmiştir.** Runtime ayırmaları örnekler; hacimler "örneklenen
  bayt"tır, tam muhasebe değildir. Örnekleme ayırma hacmiyle orantılı olduğu için **paylar**
  yansızdır, mutlak toplamlar değil — panel de bu yüzden her satırda payı gösterir.
- **Bazı ayırmaların kullanıcı kodu karşılığı yoktur.** Tamamen runtime içinde olan
  ayırmalar `runtime` etiketiyle işaretlenir: orada işaret edilecek bir satır yoktur.
- **Üst düzey statement'larla yazılmış kodda adlar derleyici üretimidir**
  (`Program.g__RunCache|0_7`); normal sınıflarda ad doğrudan sınıf ve metottur.
- **`gen-N-size` ve `loh-size` son collection'dan sonraki boyuttur.** `gc-heap-size` ise
  canlı toplamdır, bu yüzden ikisi küçük farklarla ayrışabilir (collector bunu
  `capabilities` içinde de bildirir).
- **Çalışma seti GC heap'ten küçük görünebilir.** Bu bir hata değil: commit edilmiş sayfalar
  tembel yüklenir ve OS bunları sıkıştırıp takasa atabilir. Doğrulandı: 17 GB bildirilen
  heap, 4.2 GB resident set ile birlikte gerçek.
- **`cpu-usage` tek çekirdek yüzdesine çevrilir.** Runtime bu sayacı tüm makine CPU'suna
  oranla bildirir; collector `Environment.ProcessorCount` ile çarpar, böylece `top`/`ps` ile
  aynı şeyi gösterir (100% = bir çekirdek tamamen dolu).
- Aynı sürece iki oturum birden bağlanmaz; hedefe iki kat EventPipe yükü bindirmemek için
  host bunu reddeder.
- Bağlanma izni .NET runtime'ın tanı IPC soketine bağlıdır. Farklı kullanıcıya ait veya
  `DOTNET_EnableDiagnostics=0` ile başlatılmış süreçlere bağlanılamaz.
- **Kayıtta saklama/silme politikası yok.** Diskte ne varsa o kalır; temizliği sen yaparsın
  (`Recordings` sekmesinden silinebilir, ama otomatik yaşlandırma yoktur).
- **Replay aynı anda canlı oturumla çalışmaz.** İkisi de aynı tamponlara yazacağı için host
  bunu reddeder: ya canlı bağlanırsın ya da kayıt oynatırsın.
- **Bitmiş bir replay'i sarmak yeni bir çalıştırmadır.** Replay bitince thread kapanır;
  Pause/scrub otomatik olarak yeni bir çalıştırma başlatıp istediğin noktaya ilerler.
- **Kaydedilmemiş oturum geri getirilemez.** Kayıt host tarafında, akan veriyle yapılır; bir
  oturumu kaydetmeye karar verdiğinde ondan önceki örnekler dosyada yoktur.
- **Uzun boşluklar sıkıştırılır.** Kayıtta 20 saniyeden uzun sessizlik varsa replay bunu
  20 saniyeye indirir (hızla bölünür), yoksa on dakika boş beklemiş bir servis replay'i
  donmuş gibi gösterirdi.

---

## Sorun giderme

**"Collector not found"** — collector derlenmemiş. `npm run collector:build`, ya da
`Settings` sekmesindeki yolu kullan. Aranan tüm yollar arayüzde listelenir.

**Collector değişikliğim uygulamada görünmüyor** — host, sırayla önce paketlenmiş kopyayı
(`src-tauri/resources/collector`, `tauri` tarafından `target/*/collector` altına kopyalanır)
sonra derleme çıktısını arar. Yani collector'ı değiştirip sadece `collector:build` yaptıysan,
uygulama hâlâ eski pakedi çalıştırır. `npm run collector:publish` ile tazele; eski
`.dll`'i kaynak ağacında bırakırsan özellik sessizce görünmez (ör. yeni bir probe
`capabilities` listesinde çıkmaz). Doğrulaması:

```bash
npm run collector:publish && npm run app:build
memoryspy --check | jq '.capabilities.supports'   # allocation-call-sites görünmeli
```

**Süreç listede yok** — hedef .NET süreci çalışmıyor olabilir, farklı kullanıcıya ait
olabilir veya tanı özelliği kapalı başlatılmış olabilir. `Settings → Collector` bölümünde
`.NET host` görünüyorsa host tarafı sağlam demektir.

**Veri gelmiyor ama bağlanıldı** — `Diagnostics` sekmesine bak; attach reddi, hedefin
çıkması gibi sebepler orada yazılıdır.

**Sayaçlar karışık birimde görünüyor** — collector hepsini normalize eder (boyutlar byte,
yüzdeler %, ayırma hızı byte/s). Bilinmeyen bir sayaç `Other` kategorisinde ham birimiyle
görünür; `Settings → Show every counter` ile açılır.

---

## Geliştirme

```bash
npm run typecheck          # TypeScript
npm run collector:build    # .NET sidecar
cd src-tauri && cargo test # host ↔ collector sözleşme testleri (gerçek .NET süreci ile)
npm run build              # arayüz üretim derlemesi
```

Arayüzü .NET olmadan geliştirmek için sahte arka uç var:

```bash
npm run dev
# tarayıcıda http://localhost:1420/?mock=1
```

Sahte mod, collector ile **aynı** mesaj zarfını üretir; yani gerçek protokolü doğrular.

Sözleşme testleri (`src-tauri/tests/collector_contract.rs`) örnek sızıntı uygulamasına
gerçekten bağlanır ve şunları doğrular: collector bulunuyor mu, yetenekleri doğru mu
bildiriyor, süreç listesi komut satırı ve runtime sürümüyle zenginleşiyor mu, canlı oturumda
sayaçlar byte'a normalize ediliyor mu ve sızdıran `SessionRecord` tipi tür listesinde
görünüyor mu, oturum temiz kapanıyor mu.

Bir de derin yakalama zinciri test edilir: gerçek bir capture yazılır, `.nettrace`
diskte kalır, ara ETLX silinir, frame'ler isimle çözülür (örnek uygulamanın kendi `Program`
metotları görünür) ve **bir framework tipi** (ör. `System.Byte[]`) örnek uygulamanın koduna
atfedilir. Bu son iddia, bu özellik olmadan her tip için başarısız olan iddiadır.
