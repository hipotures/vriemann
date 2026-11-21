# RH replay – proof tower (VR / desktop viewer)

Wizualizacja weryfikacji dowodu RH Alpöge'a w Lean: 175 187 modułów jako „wieża” (oś Y = głębokość importu,
pierścień = moduły danej głębokości, posortowane po nazwie). Wszystko czytane lokalnie – żadnych zapytań do GitHuba.

## Uruchomienie
    python3 build_graph.py            # raz (albo po zmianie indeksu) – układ 3D do data/
    python3 server.py --host <LAN-IP> --port 8080   # HTTP za reverse proxy (Pangolin kończy TLS)
    python3 server.py --host 0.0.0.0 --cert fullchain.pem --key privkey.pem   # HTTPS dla gogli (WebXR wymaga HTTPS)

Serwer czyta: `~/DEV/alpoge-rh-replay/tracker` (indeks, completed.tsv), `~/rh-replay-vol/lean/src` (kod Lean),
`~/rh-receipts/*/build.log` + `receipt.json` (nasze buildy na żywo), `~/rh-tools/packet.log` (status pętli). Ścieżki: `--repo --vol --receipts --packet-log`.
Biblioteka A-Frame 1.7.0 (three.js r173) leży w `vendor/` – bez CDN.

## Sterowanie
Desktop: przeciągnij = rozglądanie, WASD = ruch, Q/E = winda (głębokość), klik = wybór/przycisk, kółko nad kodem = przewijanie (w miniaturze: rozmiar),
**B lub M** = wieża ⇄ miniatura, **X** = follow live, **H lub Y** = ukryj/pokaż UI, **R** = panele przed sobą (A to „w lewo”, więc recenter to R). **+ / −** albo Shift+kółko = zoom (0 = reset).
VR (kontrolery Touch): trigger = wybór/przycisk, lewy drążek ▲▼ = winda, prawy ◀▶ = obrót świata, prawy ▲▼ nad kodem = przewijanie,
A = ustaw panele przed sobą, B = wieża ⇄ miniatura na stole, X = „follow live”, Y = ukryj/pokaż panele.

## Nagrywanie, miniatura, ręce
- **H lub Y** (klawiatura) / **Y** (lewy kontroler) – chowa/pokazuje cały interfejs: panele, podpowiedź i przycisk VR. Do nagrań.
- **Miniature** (B / M): wieża na stole. **Grip** na kontrolerze albo **szczypnięcie w pustą przestrzeń** dłonią chwyta ją i przesuwa/obraca;
  prawy drążek ▲▼ (desktop: kółko) zmienia rozmiar; **Bring to me** wsuwa oś wieży w Twoją głowę (na wysokości wybranego modułu) –
  punkty otaczają głowę z bliska. Napisy „depth” same się odwracają: na zewnątrz czytelne z zewnątrz, w środku od środka.
- **Ręce**: bez kontrolerów widać dłonie (hand tracking); celowanie = linia bark → czubek palca wskazującego, szczypnięcie = klik.
- **Wybrany moduł** to żywa kula: pełna powierzchnia z płynącymi pasmami i jedną „kometą” na każdy import (tempo rośnie z CPU procesu `lean`,
  który ten moduł właśnie kompiluje), rdzeń pulsuje i rośnie z pamięcią (RES = rozmiar rezydentny, w większości współdzielone .olean Mathliba),
  (czas/CPU/RES są w panelu Live build, nad kulą nie ma tekstu). Wokół krążą **deklaracje z kodu** (theorem/lemma/def/instance/axiom; rozmiar = długość, `axiom` na czerwono) –
  **klik w satelitę przewija kod do tej deklaracji** i ją podświetla.
  Zmiana wybranego modułu to **płynne przenikanie** (~0,4 s): stara kula gaśnie, nowa się rozjaśnia, oba widać naraz, a miękki łuk z punktem „przekazuje” uwagę od starego do nowego.
- Panel **Live build**: pasek CPU i RAM maszyny oraz liczba procesów `lean`, żeby było widać, że coś się liczy.

## Dźwięk (domyślnie wyłączony)
Generowany na żywo (Web Audio, bez plików), włączany przyciskiem **Sound** w menu albo klawiszem **N** (przeglądarka zaczyna grać dopiero po kliknięciu).
Trzy ciche warstwy: **tło** (wolny niski „oddech”: jaśniejsze z CPU, głębsze z pamięcią), **nuta za każdy zbudowany moduł** (skala pentatoniczna, głębiej = niżej,
w VR słychać ją z miejsca modułu w wieży; przerzedzana do ok. 4 na sekundę, max 10 naraz) oraz rzadki **akord** po ukończeniu naszego pakietu.
Po włączeniu słychać **dwunutowy sygnał potwierdzający**, a zmiana głośności daje krótki dźwięk, więc od razu wiadomo, czy działa. Gdy przeglądarka trzyma dźwięk zawieszony do pierwszego gestu, przycisk pokazuje **„Sound: tap”** i powód;
każde kliknięcie / klawisz / spust kontrolera ponawia próbę. Poziomy domyślne: nuty około −22…−19 dBFS, tło −40 (spokój) … −28 (obciążenie); test pilnuje, żeby nie zeszły z powrotem do niesłyszalnych.
Wszystkie liczby do strojenia są na górze `static/audio.js` (`CFG`): głośność, gęstość, jasność, długość wybrzmienia, pogłos. Głośność zapamiętuje przeglądarka.

## Układ: wieża albo helisa
Przycisk **Layout** w menu (albo klawisz **L**) przełącza układ: wieża (pierścienie) → helisa ×2 (jak DNA) → ×4 → ×8. Wysokość to nadal głębokość importu (Main na szczycie), więc winda, linijki
i znacznik Main działają tak samo; **splot = przestrzeń nazw** (wyrównana liczebnościowo, duże przestrzenie dzielone po pakietach), każdy splot to prawoskrętna helisa o promieniu 6 m,
a moduły siedzą w rurze o promieniu ~0,9 m. Układy (`data/pos_helix{2,4,8}.f32`) generuje `build_graph.py` i są ładowane dopiero przy pierwszym użyciu (2 MB). Przejście jest płynne (1,6 s).

## Połączenia (rurki 3D)
Każde połączenie wybranego modułu (importy cyjan, konsumenci magenta) to prawdziwa **rurka 3D**: oświetlona (światło rozproszone, odblask, poświata krawędzi), nieprzezroczysta,
więc rurki zasłaniają się nawzajem jak obiekty, wygięta łukiem od osi wieży. Rurki zaczynają się na **powierzchni rdzenia**, a nie w jego środku, i są tam cienkie, więc moduł z wieloma
połączeniami nie zapycha sobie środka. Wzdłuż każdej biegnie jasne **zgrubienie w kierunku przepływu wiedzy**: importy płyną DO modułu, a od modułu płyną jego konsumenci.
Rurką jest do 192 połączeń, czyli wszystkie dla ~99,8% modułów; dopiero przy hubach reszta to słaba mgła z cienkich linii. Stroi się to w `RIB` w `app.js`
(`max`, `segs`, `sides`, `width` = promień, `start`, `minPx`, `speed`, `freq`).

## Poświata (glow)
Przycisk **Glow** w menu albo klawisz **G**: wyłączona → włączona (miękka aureola wokół punktów zbudowanych / przydzielonych / naszych / kompilowanych) →
„all” (dodatkowo słaba aureola szarych, jeszcze otwartych punktów; ciężka dla GPU gogli). Aureola to ta sama geometria rysowana drugi raz, większa i addytywna – bez
kopii danych. Siłę i wielkość stroi się w `GLOW` na początku sekcji glow w `app.js`. Wybór zapamiętuje przeglądarka.

## Co widać
Kolory: szary = otwarty, niebieski = przydzielony komuś, zielony = zbudowany (inni), złoty = zbudowany przez nas, pulsujący pomarańcz = właśnie się buduje.
**Closure** (przycisk lub **C**) ma trzy tryby: wyłączone → *dim* (reszta przygaszona do 22%) → *only* (cała reszta znika, zostaje wybór i jego importy).
Wybrany moduł: cały łańcuch jego importów (cyjan), bezpośredni konsumenci (magenta), kod Lean z podświetleniem (`sorry`/`axiom` na czerwono).
Widok „Packets” = 2 858 pakietów jako kule (kolor = % zbudowania). „Follow live” wybiera moduł kompilowany najdłużej (kod + przodkowie + winda); ręczny wybór wyłącza follow.

## Testy
    node tests/test_lib.js                                   # logika na prawdziwych danych
    NODE_PATH=<…/node_modules z three@0.173.0> node tests/smoke_app.js [http://127.0.0.1:8443]   # app.js bez przeglądarki
Nie przetestowane: render GLSL i prawdziwe kontrolery (wymagają przeglądarki / gogli).
