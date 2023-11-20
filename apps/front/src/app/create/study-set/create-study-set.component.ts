import { Component, ComponentRef, ElementRef, OnInit, ViewChild, ViewContainerRef } from "@angular/core";
import { AlertComponent } from "../../shared/alert/alert.component";
import { Router } from "@angular/router";
import { SetsService } from "../../shared/http/sets.service";
import { Meta, Title } from "@angular/platform-browser";
import { CardComponent } from "../../shared/card/card.component";
import { faQuestionCircle } from "@fortawesome/free-regular-svg-icons";

@Component({
  selector: "scholarsome-create",
  templateUrl: "./create-study-set.component.html",
  styleUrls: ["./create-study-set.component.scss"]
})
export class CreateStudySetComponent implements OnInit {
  constructor(
    private readonly router: Router,
    private readonly sets: SetsService,
    private readonly titleService: Title,
    private readonly metaService: Meta
  ) {
    this.titleService.setTitle("Create a new set — Scholarsome");
    this.metaService.addTag({ name: "description", content: "Create a free new Scholarsome study set. Scholarsome is the way studying was meant to be." });
  }

  @ViewChild("cardList", { static: true, read: ViewContainerRef }) cardList: ViewContainerRef;

  @ViewChild("title", { static: false, read: ViewContainerRef }) titleInput: ViewContainerRef;
  @ViewChild("description") descriptionInput: ElementRef;
  @ViewChild("privateCheck") privateCheckbox: ElementRef;

  protected formDisabled = false;

  protected emptyTitleAlert = false;

  protected faQuestionCircle = faQuestionCircle;

  // index starts at 0
  protected cards: { component: ComponentRef<CardComponent>, index: number }[] = [];

  async createSet() {
    const cards: { index: number; term: string; definition: string; }[] = [];

    if (!this.titleInput.element.nativeElement.value && !this.emptyTitleAlert) {
      const alert = this.titleInput.createComponent<AlertComponent>(AlertComponent);

      alert.instance.message = "Title must not be empty";
      alert.instance.type = "danger";
      alert.instance.dismiss = true;
      alert.instance.spacingClass = "mt-3";

      this.emptyTitleAlert = true;
      setTimeout(() => this.emptyTitleAlert = false, 3000);

      return;
    } else if (!this.titleInput.element.nativeElement.value) return;

    for (const card of this.cards) {
      if (card.component.instance.term.length !== 0 && card.component.instance.definition.length !== 0) {
        cards.push({
          index: card.component.instance.cardIndex,
          term: card.component.instance.term,
          definition: card.component.instance.definition
        });
      } else {
        card.component.instance.notifyEmptyInput();
        return;
      }
    }

    this.formDisabled = true;

    const set = await this.sets.createSet({
      title: this.titleInput.element.nativeElement.value,
      description: this.descriptionInput.nativeElement.value,
      private: this.privateCheckbox.nativeElement.checked,
      cards
    });

    await this.router.navigate(["/study-set/" + set?.id]);
  }

  updateCardIndices() {
    for (let i = 0; i < this.cards.length; i++) {
      this.cards[i].component.instance.cardIndex = i;
      this.cards[i].index = i;

      this.cards[i].component.instance.upArrow = i !== 0;
      this.cards[i].component.instance.downArrow = this.cards.length - 1 !== i;
      this.cards[i].component.instance.trashCan = this.cards.length > 1;
    }
  }

  addCard() {
    const card = this.cardList.createComponent<CardComponent>(CardComponent);
    card.instance.cardIndex = this.cardList.length - 1;
    card.instance.editingEnabled = true;

    card.instance.deleteCardEvent.subscribe((e) => {
      if (this.cardList.length > 1) {
        this.cardList.get(e)?.destroy();

        this.cards.splice(this.cards.map((c) => c.index).indexOf(e), 1);

        this.updateCardIndices();
      }
    });

    card.instance.moveCardEvent.subscribe((e) => {
      if (this.cardList.length > 1) {
        const cardIndex = this.cards.map((c) => c.index).indexOf(e.index);

        this.cardList.move(this.cards[cardIndex].component.hostView, e.index + e.direction);

        this.cards[this.cards.map((c) => c.index).indexOf(e.index + e.direction)].index = e.index;
        this.cards[cardIndex].index = e.index + e.direction;

        this.cards.sort((a, b) => a.index - b.index);

        this.updateCardIndices();
      }
    });

    card.instance.addCardEvent.subscribe(() => {
      this.addCard();
    });

    this.cards.push({
      component: card,
      index: this.cardList.length - 1
    });

    this.updateCardIndices();
  }

  ngOnInit() {
    this.addCard();
  }
}
