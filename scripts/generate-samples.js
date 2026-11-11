const fs = require('fs');
const path = require('path');
const AdmZip = require('adm-zip');

const novelsDir = path.join(__dirname, '..', 'novels');
const publicDir = path.join(__dirname, '..', 'public');
const vendorDir = path.join(publicDir, 'vendor');

fs.mkdirSync(path.join(novelsDir, '古典文学'), { recursive: true });
fs.mkdirSync(path.join(novelsDir, '仙侠修真'), { recursive: true });
fs.mkdirSync(path.join(novelsDir, '科幻悬疑'), { recursive: true });
fs.mkdirSync(vendorDir, { recursive: true });

// Copy browser vendor bundles (opencc-js and jszip) for static/WebDAV mode
fs.copyFileSync(
  path.join(__dirname, '..', 'node_modules/opencc-js/dist/umd/cn2t.js'),
  path.join(vendorDir, 'opencc-cn2t.js')
);
fs.copyFileSync(
  path.join(__dirname, '..', 'node_modules/jszip/dist/jszip.min.js'),
  path.join(vendorDir, 'jszip.min.js')
);

// 1. Create Sample TXT #1: 三国演义（节选）.txt
const sanGuoTxt = `书名：三国演义（精选卷）
作者：罗贯中

第一回 宴桃园豪杰三结义 斩黄巾英雄首立功

滚滚长江东逝水，浪花淘尽英雄。是非成败转头空。青山依旧在，几度夕阳红。
白发渔樵江渚上，惯看秋月春风。一壶浊酒喜相逢。古今多少事，都付笑谈中。

话说天下大势，分久必合，合久必分。周末七国分争，并入于秦。及秦灭之后，楚、汉分争，又并入于汉。汉朝自高祖斩白蛇而起义，一统天下，后来光武中兴，传至献帝，遂分为三国。

且说张角散施符水，为人治病，自称“大贤良师”。角有徒弟五百余人，云游四方，皆能书符念咒。次后徒众日多，角乃立三十六方，大方万余人，小方六七千，各立渠帅，称为将军；讹言：“苍天已死，黄天当立；岁在甲子，天下大吉。”

幽州太守刘焉，乃江夏竟陵人氏，汉鲁恭王之后也。当时闻得贼兵将至，召校尉邹靖计议。靖曰：“贼兵众，我兵寡，明公宜作速招军应敌。”刘焉然其说，随即出榜招义兵。

榜文行到涿县，引出涿县中一个英雄。那人不甚好读书；性宽和，寡言语，喜怒不形于色；素有大志，专好结交天下豪杰；生得身长七尺五寸，两耳垂肩，双手过膝，目能自顾其耳，面如冠玉，唇若涂脂；中山靖王刘胜之后，汉景帝阁下玄孙，姓刘，名备，字玄德。

当日刘备见了榜文，慨然长叹。随后一人厉声言曰：“大丈夫不与国家出力，何故长叹？”玄德回视其人，身长八尺，豹头环眼，燕颔虎须，声若巨雷，势如奔马。玄德见他形貌异常，问其姓名。其人曰：“某姓张，名飞，字翼德。世居涿郡，颇有庄田，卖酒屠猪，专好结交天下豪杰。恰才见公看榜而叹，故此相问。”

玄德曰：“我本汉室宗亲，姓刘，名备。今闻黄巾倡乱，有志欲破贼安民，恨力不能，故长叹耳。”飞曰：“吾颇有资财，当招募乡勇，与公同举大事，如何？”玄德甚喜，遂与同入村店中饮酒。

正饮间，见一大汉，推着一辆车子，到店门首歇了，入店坐下，便唤酒保：“快斟酒来吃，我待赶入城去投军！”玄德看其人：身长九尺，髯长二尺；面如重枣，唇若涂脂；丹凤眼，卧蚕眉，相貌堂堂，威风凛凛。玄德就邀他同坐，叩其姓名。其人曰：“吾姓关，名羽，字长生，后改云长，河东解良人也。因本处势豪倚势凌人，被吾杀了，逃难江湖，五六年矣。今闻此处招军破贼，特来应募。”玄德遂以己志告之，云长大喜。同到张飞庄上，共议大事。

飞曰：“吾庄后有一桃园，花开正盛；明日当于园中祭告天地，我三人结为兄弟，协力同心，然后可图大事。”玄德、云长齐声应曰：“如此甚好。”

次日，于桃园中，备下乌牛白马祭礼等项，三人焚香，再拜而说誓曰：“念刘备、关羽、张飞，虽然异姓，既结为兄弟，则同心协力，救困扶危；上报国家，下安黎庶。不求同年同月同日生，只愿同年同月同日死。皇天后土，实鉴此心，背义忘恩，天人共戮！”誓毕，拜玄德为兄，关羽次之，张飞为弟。

第二回 张翼德怒鞭督邮 何国舅谋诛宦竖

且说董卓字仲颖，陇西临洮人也，官拜河东太守，自来骄傲。当日怠慢了玄德，张飞性发，便欲杀之。玄德与关公急止之曰：“他是朝廷命官，岂可擅杀？”飞曰：“若不杀这厮，反要在他部下听令，其实不甘！二兄要便住在此，我自投别处去也！”玄德曰：“我三人义同生死，岂可相离？不若都投别处去便了。”飞曰：“若如此，稍解吾恨。”

于是三人连夜引军来投朱儁。儁待之甚厚，合兵一处，进讨张宝。是时曹操自跟皇甫嵩讨张梁，大战于曲阳。这里朱儁进攻张宝。张宝引贼众八九万，屯于山后。儁令玄德为其先锋，与贼对敌。张宝遣副将高升出马搦战，玄德使张飞击之。飞纵马挺矛，与升交战，不数合，刺升落马。玄德麾军直冲过去。张宝就马上披发仗剑，作起妖法。只见风雷大作，一股黑气从天而降，黑气中似有无限人马杀来。玄德连忙回军，军中大乱。

朱儁与玄德计议曰：“彼用妖术，我来日可宰猪羊狗血，令军士伏于山头；候贼赶来，从高坡上泼之，其法可解。”玄德听令，拨关公、张飞各引军一千，伏于山后高冈之上，盛猪羊狗血并秽物准备。次日，张宝摇旗擂鼓，引军搦战，玄德出迎。交锋之际，张宝作法，风雷大作，飞砂走石，黑气满天，滚滚人马，自天而下。玄德拨马便走，张宝驱兵赶来。将过山头，关、张伏军放起号炮，秽物齐泼。但见空中纸人草马，纷纷坠地；风雷顿息，砂石不飞。

第三回 议温明董卓叱丁原 馈金珠李肃说吕布

且说曹操当日对何进曰：“宦官之祸，古今皆有；但世主不当假之权宠，使至于此。若欲治罪，当除元恶，但付一狱吏足矣，何必纷纷召外兵乎？欲尽诛之，事必宣露，吾料其必败也。”何进怒曰：“孟德亦怀私意耶？”操退曰：“乱天下者，必进也。”

后人读史至此，常叹息不已。当夜月明风清，洛阳城外旌旗蔽空，千里铁骑踏碎秋霜。
`;

fs.writeFileSync(path.join(novelsDir, '古典文学', '三国演义（精选卷）.txt'), sanGuoTxt, 'utf8');

// 2. Create Sample TXT #2: 青云剑仙传.txt
const xianXiaTxt = `书名：青云剑仙传
作者：云山散人

第一章 寒门少年与古剑残卷

苍茫的青云山脉深处，晨雾如纱，笼罩着一座古朴的道观。
少年林澈盘膝坐在青石之上，手中捧着一卷泛黄的古籍。这卷古籍是他三日前在藏经阁底层清理灰尘时偶然发现的，封皮上隐约可见“太虚剑典”四个古篆字。

“世人皆言修行需看灵根资质，然而真正的剑道，在于心诚与悟性。”林澈轻声诵读着书页上的注解，只觉得胸口涌起一股温热的气流，顺着经脉缓缓流淌。

山风吹拂过松林，发出阵阵涛声。远处的钟楼传来三声悠扬的晨钟，唤醒了整座山门。

第二章 藏经阁中的惊世秘闻

午后时分，守阁长老拄着竹杖缓步走入阁中。看到林澈仍在研读那卷残破的竹简，长老眼中闪过一丝讶异。
“林澈，这卷竹简已经在阁中尘封了三百余年，历代弟子无人能读懂其中的剑意，你竟能静下心来看完？”

林澈起身行礼，恭敬地答道：“回禀长老，弟子起初也觉得字迹晦涩，但当弟子不再执着于招式，而是顺着字里行间的呼吸吐纳去感应时，仿佛看到了前人仗剑行于云海之上的画面。”

长老抚须长笑：“善哉！剑道无涯，唯心而已。明日便是外门大比，你且去后山竹林试剑，切莫辜负了这一场机缘。”

第三章 夜雨试剑破苍穹

是夜，山雨欲来，电光在云层间穿梭。
林澈独自立于后山断崖之前，手中握着一柄寻常的青钢长剑。随着一声惊雷炸响，豆大的雨点倾盆而下，然而在距离他周身三尺之处，雨滴却仿佛遇到了无形的屏障，化作漫天水雾四散开来。

他缓缓抬起手腕，一剑挥出，剑光如清泉映月，瞬间照亮了幽暗的山谷！
`;

fs.writeFileSync(path.join(novelsDir, '仙侠修真', '青云剑仙传.txt'), xianXiaTxt, 'utf8');

// 3. Create Sample EPUB: 星海迷航记.epub
const epubZip = new AdmZip();
epubZip.addFile('mimetype', Buffer.from('application/epub+zip', 'utf8'));
epubZip.addFile(
  'META-INF/container.xml',
  Buffer.from(
    `<?xml version="1.0" encoding="UTF-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>
  </rootfiles>
</container>`,
    'utf8'
  )
);

epubZip.addFile(
  'OEBPS/content.opf',
  Buffer.from(
    `<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" unique-identifier="BookId" version="2.0">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:title>星海迷航记：深空回响</dc:title>
    <dc:creator>星辰旅者</dc:creator>
    <dc:language>zh-CN</dc:language>
    <dc:description>一部关于人类远征舰队跨越银心虫洞、探寻远古文明遗迹的硬核科幻小说。</dc:description>
    <dc:identifier id="BookId">urn:uuid:12345678-1234-5678-1234-567812345678</dc:identifier>
  </metadata>
  <manifest>
    <item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>
    <item id="ch1" href="chapter1.xhtml" media-type="application/xhtml+xml"/>
    <item id="ch2" href="chapter2.xhtml" media-type="application/xhtml+xml"/>
    <item id="ch3" href="chapter3.xhtml" media-type="application/xhtml+xml"/>
  </manifest>
  <spine toc="ncx">
    <itemref idref="ch1"/>
    <itemref idref="ch2"/>
    <itemref idref="ch3"/>
  </spine>
</package>`,
    'utf8'
  )
);

epubZip.addFile(
  'OEBPS/toc.ncx',
  Buffer.from(
    `<?xml version="1.0" encoding="UTF-8"?>
<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1">
  <head>
    <meta name="dtb:uid" content="urn:uuid:12345678-1234-5678-1234-567812345678"/>
  </head>
  <docTitle><text>星海迷航记：深空回响</text></docTitle>
  <navMap>
    <navPoint id="navPoint-1" playOrder="1">
      <navLabel><text>第一章 启航：跨越奥尔特星云</text></navLabel>
      <content src="chapter1.xhtml"/>
    </navPoint>
    <navPoint id="navPoint-2" playOrder="2">
      <navLabel><text>第二章 异星信号与量子计算机</text></navLabel>
      <content src="chapter2.xhtml"/>
    </navPoint>
    <navPoint id="navPoint-3" playOrder="3">
      <navLabel><text>第三章 寂静星域的守望者</text></navLabel>
      <content src="chapter3.xhtml"/>
    </navPoint>
  </navMap>
</ncx>`,
    'utf8'
  )
);

epubZip.addFile(
  'OEBPS/chapter1.xhtml',
  Buffer.from(
    `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml">
<head><title>第一章 启航：跨越奥尔特星云</title></head>
<body>
  <h1>第一章 启航：跨越奥尔特星云</h1>
  <p>公元2248年，人类第一艘装备曲率引擎的远征舰“远望七号”缓缓驶离木星轨道船坞。透过全景舷窗望去，太阳已经缩小成一颗温暖而孤独的亮星。</p>
  <p>舰长苏言站在指挥台前，看着全息屏幕上不断刷新的导航信息与计算机诊断数据。舰载人工智能用平稳的语调汇报：“曲率泡稳定度百分之九十九点八，预计三分钟后进入超光速巡航状态。”</p>
  <p>这是一场没有回头路的漫长旅途。为了寻找三年前在天鹅座方向突然出现的规律脉冲信号，远征队将跨越四十二光年的深空，前往人类从未踏足的星域。</p>
</body>
</html>`,
    'utf8'
  )
);

epubZip.addFile(
  'OEBPS/chapter2.xhtml',
  Buffer.from(
    `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml">
<head><title>第二章 异星信号与量子计算机</title></head>
<body>
  <h1>第二章 异星信号与量子计算机</h1>
  <p>当“远望七号”脱离曲率空间时，眼前的景象让整个舰桥陷入了长久的沉默。在距离飞船不到十万公里的轨道上，悬浮着一座直径超过三百公里的环形巨构建筑。</p>
  <p>“正在通过舰载量子计算机解析对方发送的射电数据包，”首席科学官林岚放大了屏幕上的波形，“这不是普通的信标，而是一部记载着恒星演化史的立体百科全书！”</p>
  <p>随着软件解码程序逐层深入，一段跨越百万年的宇宙记忆在众人眼前徐徐展开。</p>
</body>
</html>`,
    'utf8'
  )
);

epubZip.addFile(
  'OEBPS/chapter3.xhtml',
  Buffer.from(
    `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml">
<head><title>第三章 寂静星域的守望者</title></head>
<body>
  <h1>第三章 寂静星域的守望者</h1>
  <p>环形巨构的中心亮起了一道柔和的蔚蓝光束，将“远望七号”轻轻笼罩。全息投影仪上浮现出一行由数学公理转译而成的文字：</p>
  <p>“欢迎来到群星的交汇处，年轻的远航者。当你们读懂这段信息时，你们便不再是宇宙中的孤岛。”</p>
  <p>苏言深吸一口气，下达了载入人类史册的命令：“开启全频段通讯，向地球总部发送第一份星际接触报告。”</p>
</body>
</html>`,
    'utf8'
  )
);

epubZip.writeZip(path.join(novelsDir, '科幻悬疑', '星海迷航记.epub'));

// 4. Generate public/demo-books.json for GitHub Pages static preview mode
const { parseTxtBuffer, parseEpubBuffer } = require('../server/parsers');
const demoFiles = [
  {
    id: 'demo-sanguo',
    folder: '古典文学',
    filename: '三国演义（精选卷）.txt',
    format: 'txt',
    buffer: fs.readFileSync(path.join(novelsDir, '古典文学', '三国演义（精选卷）.txt'))
  },
  {
    id: 'demo-xianxia',
    folder: '仙侠修真',
    filename: '青云剑仙传.txt',
    format: 'txt',
    buffer: fs.readFileSync(path.join(novelsDir, '仙侠修真', '青云剑仙传.txt'))
  },
  {
    id: 'demo-scifi',
    folder: '科幻悬疑',
    filename: '星海迷航记.epub',
    format: 'epub',
    buffer: fs.readFileSync(path.join(novelsDir, '科幻悬疑', '星海迷航记.epub'))
  }
];

const demoData = demoFiles.map((item) => {
  const parsed =
    item.format === 'epub'
      ? parseEpubBuffer(item.buffer, item.filename, item.id)
      : parseTxtBuffer(item.buffer, item.filename);
  return {
    id: item.id,
    source: 'demo',
    relativePath: `${item.folder}/${item.filename}`,
    filename: item.filename,
    title: parsed.title,
    originalTitle: parsed.title,
    author: parsed.author,
    description: parsed.description,
    folder: item.folder,
    originalFolder: item.folder,
    format: item.format,
    size: item.buffer.length,
    mtime: new Date().toISOString(),
    totalChapters: parsed.totalChapters,
    totalWords: parsed.totalWords,
    chapters: parsed.chapters
  };
});

fs.writeFileSync(path.join(publicDir, 'demo-books.json'), JSON.stringify(demoData, null, 2), 'utf8');

console.log('Sample novels, demo-books.json, and vendor bundles generated successfully.');

