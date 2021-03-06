window.addEventListener("load", function() { fb2.init(); }, false)

var fb2 = {

// ------------------- XML NAMESPACES ------------------------
    FB2_NS   : 'http://www.gribuser.ru/xml/fictionbook/2.0',
    XLink_NS : 'http://www.w3.org/1999/xlink',
    HTML_NS : 'http://www.w3.org/1999/xhtml',

// ------------------- UTILITIES ------------------

    // see https://developer.mozilla.org/en/Xml/id
    // and http://bit.ly/24gZUo for a reason why it is needed
    getElements : function (doc, query, resultType) {
        if (resultType == null)
            resultType = XPathResult.UNORDERED_NODE_SNAPSHOT_TYPE

        // could use: namespace-uri()='"+fb2.FB2_NS+"' and ..
        return doc.evaluate("//fb2:"+query, doc.documentElement,
                    function(){return fb2.FB2_NS},
                    resultType, null
                    );
    },

    getSingleElement : function (doc, query) {
        return fb2.getElements(doc, query, XPathResult.FIRST_ORDERED_NODE_TYPE).singleNodeValue
    },

    getHrefVal : function(elem){ // returns id of element XLink ponts to, like l:href="#note1"
        return elem.getAttributeNS(fb2.XLink_NS, 'href').slice(1)
    },

    getDocId: function(doc){
        var id = fb2.getSingleElement(doc, "id")
        if (id)
            id = id.textContent
        else
            id = doc.title
        return id
    },

    getDocHeight: function(doc) {
        return parseInt(doc.defaultView.getComputedStyle(
            doc.documentElement,null).getPropertyValue("height").slice(0, -2))
    },

//----------------------- INIT -------------------------------

	getPaletteButton: function() {
        // For some weird reason document.getElementById("fb2reader-toggle")
        // works only when the button is visible
        // this here works for cases when it is not
		var toolbox = document.getElementById("navigator-toolbox");
		if (!toolbox || !("palette" in toolbox) || !toolbox.palette)
			return null;

		for (var child = toolbox.palette.firstChild; child; child = child.nextSibling)
			if (child.id == "fb2reader-toggle")
				return child;

		return null;
	},

    syncToggle: function(){
        var button = fb2.getPaletteButton() || document.getElementById("fb2reader-toggle");
        if (button)
            button.setAttribute('state', fb2.prefs.getBoolPref("enabled") ? 1:0 );
    },

	prefObserver : {
		observe: function(subject, topic, data) {
			if(data == "extensions.fb2reader.enabled")
			    fb2.syncToggle();
    	},

		QueryInterface : function (aIID) {
			if (aIID.equals(Components.interfaces.nsIObserver) ||
				aIID.equals(Components.interfaces.nsISupports) ||
				aIID.equals(Components.interfaces.nsISupportsWeakReference))
				return this;
			throw Components.results.NS_NOINTERFACE;
		}
	},

    init: function() {
        var appcontent = document.getElementById("appcontent") // browser
        var iPrefs = Components.classes["@mozilla.org/preferences-service;1"]
                    .getService(Components.interfaces.nsIPrefService)
        this.prefs = iPrefs.getBranch("extensions.fb2reader.")

		var pbi = iPrefs.QueryInterface(Components.interfaces.nsIPrefBranchInternal);
		pbi.addObserver("extensions.fb2reader.", fb2.prefObserver, true);

        if (appcontent)
            appcontent.addEventListener("DOMContentLoaded", fb2.onPageLoad, true);

        fb2.syncToggle();
    },

//------------------------------ WORKHORSES ---------------------

    // Database stuff
    dbConnection: null,
    dbInit: function() {
        Components.utils.import("resource://gre/modules/Services.jsm");
        Components.utils.import("resource://gre/modules/FileUtils.jsm");

        var file = FileUtils.getFile("ProfD", ["fb2reader.sqlite"]);
        var alreadyExists = file.exists();
        fb2.dbConnection = Services.storage.openDatabase(file);
        if (!alreadyExists)
            fb2.dbConnection.createTable('books', "id text PRIMARY KEY, position REAL");
    },

    savePosition: function(event) {
        var doc = event.target
        if (!fb2.getDocId(doc))
            return // do not save position for books without ID
        var win = doc.defaultView
        var height = fb2.getDocHeight(doc)
        var statement = fb2.dbConnection.createStatement("INSERT OR REPLACE INTO books(id, position) VALUES(:book_id, :position)");
        statement.params.book_id = fb2.getDocId(doc)
        statement.params.position = win.pageYOffset / height
        try {
            statement.execute()
        } catch (e if e.code == e.NS_ERROR_FILE_IS_LOCKED) {
            // ignore failed write attempts
        }
    },

    loadPosition: function(event) {
        var doc = event.target
        var win = doc.defaultView
        var statement = fb2.dbConnection.createStatement("SELECT position FROM books WHERE id = :book_id");
        statement.params.book_id = fb2.getDocId(doc)
        if (statement.executeStep()){
            win.scrollTo(0, parseFloat(statement.row.position) * fb2.getDocHeight(doc))
        }
    },

    tooltip: function(event) {
        const SCROLLBAR = 24 // I wonder if there is a reliable way to get it

        var a = event.target
        var doc = event.target.ownerDocument
        if (a.nodeName=='a'){

            try { // move it here if not yet
                var note = fb2.getSingleElement(doc, "section[@id='"+fb2.getHrefVal(a)+"']")
                a.appendChild(note)
            } catch(e) { // just get it
                var note = a.firstChild
                while (note.nodeName != 'section')
                    note = note.nextSibling
            }

            // alters the note's box position_h to keep it on screen
            if ( note.getBoundingClientRect().right > window.innerWidth - SCROLLBAR)
                note.setAttribute('position_h', 'left')
            if ( note.getBoundingClientRect().left < 0 )
                note.setAttribute('position_h', '')

            // alters the note's box position_v to keep it on screen
            if ( note.getBoundingClientRect().bottom > window.innerHeight - SCROLLBAR)
                note.setAttribute('position_v', 'up')
            if ( note.getBoundingClientRect().top < 0 )
                note.setAttribute('position_v', '')
        }
    },

    onPageLoad: function(event) {
        // yes, book.zip is to be tried. If document managed to fire 'load' event, one can expect anything.
        const FB2_REGEX = /\.(fb2|zip)(#.*)?$/g

        // that is the document which triggered event
        var doc = event.originalTarget

        // execute for FictionBook only
        if( !doc.location.href.match(FB2_REGEX) ||
            doc.getElementsByTagName("FictionBook").length == 0 ||
            !fb2.prefs.getBoolPref("enabled") )
            return

        // set booky paragraphs
        if (fb2.prefs.getBoolPref("booky_p") ) {
            doc.getElementsByTagName("FictionBook")[0].setAttribute('class', 'booky_p')
        }

        // for each fb2 image we will create xHTML one
        var images = fb2.getElements(doc, "image")
        for ( var i=0 ; i < images.snapshotLength; i++ ) {
            try { // ignore malformed images
                var img = images.snapshotItem(i)
                // we get corresponding binary node
                var bin = fb2.getSingleElement(doc, "binary[@id='"+fb2.getHrefVal(img)+"']")
                // create xhtml image and set src to its base64 data
                var ximg = doc.createElementNS(fb2.HTML_NS, 'img')
                ximg.src='data:'+bin.getAttribute('content-type')+';base64,'+bin.textContent
                img.parentNode.insertBefore(ximg, img)
            } catch(e) {}
        }

        // add listener to all footnote links
        var notelinks = fb2.getElements(doc, "a[@type='note']")
        for ( var i=0 ; i < notelinks.snapshotLength; i++ ) {
            var note = notelinks.snapshotItem(i)
            note.addEventListener("mouseover", fb2.tooltip, true)
        }

        // build index
        var body = fb2.getSingleElement(doc, "body[@name!='notes' or not(@name)]")
        var div = doc.getElementById('contents')
        var ul = doc.createElementNS(fb2.HTML_NS, 'ul');
        div.appendChild(ul)

        var title_counter = 1;
        var walk_sections = function(start, ul) {
            var sections = doc.evaluate("./fb2:section", start,
                    function(){return fb2.FB2_NS},
                    XPathResult.ORDERED_NODE_SNAPSHOT_TYPE , null
                    );
            for ( var i=0 ; i < sections.snapshotLength; i++ ) {
                var section = sections.snapshotItem(i)
                var title = doc.evaluate("./fb2:title", section,
                        function(){return fb2.FB2_NS},
                        XPathResult.FIRST_ORDERED_NODE_TYPE, null
                        ).singleNodeValue;
                if (title) {
                    var title_copy = title.cloneNode(true)

                    // cleanse ids of copied intitle elements
                    var kids = doc.evaluate("//fb2:*", title_copy,
                            function(){return fb2.FB2_NS},
                            XPathResult.ORDERED_NODE_SNAPSHOT_TYPE , null
                            );
                    for(var j=0; j<kids.snapshotLength; j++ )
                        kids.snapshotItem(j).setAttribute("id", "")

                    var a = doc.createElementNS(fb2.HTML_NS, 'a')
                    a.appendChild(title_copy)

                    // for usual local href navigation, no hacks
                    var span = doc.createElementNS(fb2.HTML_NS, 'span')
                    span.id = "zz_" + title_counter++;
                    title.insertBefore(span, title.firstChild)
                    a.href= "#"+span.id;

                    var li = doc.createElementNS(fb2.HTML_NS, 'li')
                    li.appendChild(a)
                    ul.appendChild(li)
                    var sub_ul = doc.createElementNS(fb2.HTML_NS, 'ul')
                    li.appendChild(sub_ul)
                    walk_sections(section, sub_ul)
                }
            }
        }

        if (body)
            walk_sections(body, ul)

        // documents without proper sectioning are not that unusual
        if (!ul.hasChildNodes()){
            div.parentNode.removeChild(div)
        }

        // replace FB2 links with xHTML ones
        var extlinks = fb2.getElements(doc, "a[@type!='note' or not(@type)]")
        for ( var i=0 ; i < extlinks.snapshotLength; i++ ) {
            var link = extlinks.snapshotItem(i)
            var href = link.getAttributeNS(fb2.XLink_NS, 'href')
            var xlink= doc.createElementNS(fb2.HTML_NS, 'a')
            xlink.href = href
            link.parentNode.insertBefore(xlink, link)
            // move contents
            while(link.firstChild)
                xlink.appendChild(link.firstChild)

            // for local links to FB2 elements we will create HTML anchors
            if (href.slice(0,1) == '#') {
                var id = href.slice(href.indexOf("#")+1)
                var elem = fb2.getSingleElement(doc, "*[@id='"+id+"']")
                if (elem) {
                    elem.setAttribute("id", "")
                    var span = doc.createElementNS(fb2.HTML_NS, 'span')
                    span.id = id
                    elem.parentNode.insertBefore(span, elem)
                }
            } else {
                xlink.target = "_blank"
            }
        }
        fb2.dbInit();

        // schedule restoring reading position
        var win = doc.defaultView
        win.addEventListener("load", fb2.loadPosition , false)

        // handler to save reading position on close
        doc.defaultView.addEventListener("beforeunload", fb2.savePosition, false)

    } // onPageLoad end
}
