# Label Studio

[Tiếng Việt](README.md) · [English](README.en.md) · [日本語](README.ja.md)

PT-260 サーマルラベルプリンター用のラベルデザイン・印刷アプリケーション
です。ローカルで動作するウェブインターフェースと、テキストや画像を印刷する
コマンドラインツールが含まれています。

## 主な機能

- 既存のテンプレートまたは白紙からラベルをデザインできます。
- テキストや画像の追加、QRコードの作成、画像編集、背景除去、画像領域の選択。
- プレビュー、PNG/PDFへの書き出し、デザインの保存、PT-260への直接印刷。
- 動的データを使用したラベルのプレビューと一括印刷。
- ベトナム語、英語、日本語のインターフェース。
- 個人用テンプレートをローカルのSQLiteデータベースに保存。

## 動作要件

- Windows、Python 3.10以降。
- 印刷する場合は、PT-260プリンターをBluetoothでコンピューターにペアリング。
- 初回のONNXモデルのダウンロードと、CDNからJavaScriptライブラリを読み込むため
  のインターネット接続。

## テストに使用した機器

本プロジェクトは、PT-260サーマルラベルプリンターでテストされています。
コンパクトな黒色の本体には前面ディスプレイと操作ボタンがあり、感熱ラベル
ロールを使用します。プリンターはBluetoothでコンピューターに接続します。
使用するロールに合わせて、ラベルサイズとラベル間のギャップを設定してください。

![テストに使用したPT-260サーマルラベルプリンターとラベルロール](static/images/device.png)

## インストール

PowerShellでプロジェクトディレクトリに移動し、仮想環境を作成してPython依存
パッケージをインストールします。

```powershell
python -m venv .venv
.\.venv\Scripts\Activate.ps1
python -m pip install --upgrade pip
python -m pip install Pillow pyserial qrcode
```

PowerShellで仮想環境を有効化できない場合は、`python` の代わりに
`.\.venv\Scripts\python.exe` を直接実行してください。

## プリンターの設定

最初にPT-260をWindowsとペアリングし、次のコマンドを実行します。

```powershell
python detect_printer.py
```

ラベルの幅、高さ、ラベル間のギャップをミリメートル単位で入力します。
スクリプトがプリンターポートを検出し、設定を `printer.env` に保存します。
このファイルは各コンピューター固有の設定を含むため、Gitでは追跡されません。

## デザイン画面の起動

```powershell
python label_maker.py
```

ブラウザーで [http://127.0.0.1:8765](http://127.0.0.1:8765) を開きます。
サーバーを停止するには `Ctrl+C` を押してください。

サーバーはすべてのネットワークインターフェース (`0.0.0.0`) で待ち受けます。
信頼できるネットワークでのみ実行し、このポートをインターネットに公開しないで
ください。

### ONNXモデルのダウンロード

サイズの大きいONNXファイルはGitに含まれていません。画像領域選択と背景除去の
機能を使う前に、次のコマンドでモデルをダウンロードしてください。

```powershell
python download_models.py
```

モデルは `static/models/` に保存されます。既存ファイルはスキップされ、
ダウンロードが完了した場合にのみ保存先ファイルが置き換えられます。
再ダウンロードするには `python download_models.py --force` を実行します。
モデルのリビジョンは固定されています。配布元とライセンスの詳細は
[static/models/README.txt](static/models/README.txt) を参照してください。

## コマンドラインから印刷

プリンターを設定した後、テキストを印刷します。

```powershell
python print_label.py --text "商品名 - 25.00"
```

画像を印刷します。

```powershell
python print_label.py --image ".\static\images\sample.png"
```

グレースケール写真の場合は、ディザリングを有効にできます。

```powershell
python print_label.py --image ".\static\images\sample.png" --dither
```

引数を付けずに `python print_label.py` を実行すると、対話形式で印刷内容を入力
できます。

## データとライセンス

- ラベルデザインはローカルの `label-studio.sqlite3` に保存されます。個人用
  テンプレートはブラウザーのフィンガープリントに関連付けられますが、これは
  セキュアなアカウントではありません。
- `printer.env`、SQLiteデータベース、`*.onnx` ファイルはGitの対象外です。
- RMBG-1.4は、既定のライセンス条件で商用利用が制限されています。商用利用または
  配布の前に [static/models/README.txt](static/models/README.txt) のライセンスを
  確認し、BRIAから適切なライセンスを取得してください。
- OpenMojiステッカーのクレジットとライセンス情報は
  [static/stickers/ATTRIBUTION.txt](static/stickers/ATTRIBUTION.txt) および
  `static/stickers/OPENMOJI-LICENSE.txt` に記載されています。

## 主なファイル構成

```text
label_maker.py       ローカルウェブインターフェースとAPIサーバー
print_label.py       TSPL生成とコマンドライン印刷
detect_printer.py    プリンター検出とprinter.envの設定
download_models.py   ONNXモデルをstatic/models/にダウンロード
static/              インターフェース、ラベルテンプレート、ステッカー、モデル設定
```
