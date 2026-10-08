jadi gini ada use case 

buat kebutuhan inventaris, buat konsistensi laba rugi

order ke vendor tsel misal nya MCT  tgl 11jan2026 

*sp tsel 10gb harga 7000/pcs ada 200pcs
*vc tsel 20gb harga 10000/pcs ada 200pcs

ini jadi batch 1
------------------

order beda vendor ke MKN 

tgl 20jan2026 order lagi produk yg sama tapi harga barang nya naik / turun


*sp tsel 10gb harga 7200/pcs ada 100pcs naik per pcs / 200
*vc tsel 20gb harga 9500/pcs ada 22pcs turun per pcs / 500

jadi batch 2 

###

``` 
1. jadi di pos kasir bisa pilih product di bacth yg mana walau pun produk sama tapi kan harga beli dan cunrrent qty di batch nya beda
2. coba cek uiux nya ![\[Image 2\] ](file:///Users/dhimassg/Library/Group%20Containers/group.net.whatsapp.WhatsApp.shared/Message/Media/120363406072957277@g.us/9/7/975fc0ca-590a-48cd-a826-0da29d040184.jpg)
3. pastikan saat input stok barang harus ada harga beli, harga jual (ini seharusnya auto dari saat input stok batch ada persentasi mau di jual dengan berapa %, atau bisa juga per pcs tambah harga jual)
4. contoh perdana telkomsel 10gb beli 200 qty ini di harga perpcs adalah 12500, maka harga beli nya 12500 lalu set harga jual 1000 maka yg di tampilkan adalah 12500+1000=13500,
5. kasir customer beli dan nego dengan garga 12300 ini harga nego dan bisa
6. jadi harga jual itu tidak terikat, hanya saja tidak boleh jual di bawah harga beli
7. pastikan flow ini benar untuk end to end process sampai dengan stok opname 
```